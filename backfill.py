"""
NewsLink Backfill Script — runs via GitHub Actions
Reprocesses all existing articles with the latest Groq prompt.
"""
import json, base64, urllib.request, urllib.error, re, time, os

TOKEN    = os.environ.get("GITHUB_TOKEN", "")
GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
REPO     = "pmaharaj-cc/newslink-vault"
GH       = f"https://api.github.com/repos/{REPO}"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GH_H     = {"Authorization": f"token {TOKEN}", "User-Agent": "newslink-backfill",
            "Accept": "application/vnd.github.v3+json", "Content-Type": "application/json"}

SYSTEM_PROMPT = """Extract Trinidad news. Return JSON array only. One object per article. Fields:
title,authors([str]),date_reported(YYYY-MM-DD),date_effective(YYYY-MM-DD|null),
people([{name,role,legal_status}]),organizations([str]),places([str]),
topics([economy|crime|government|health|environment|energy|foreign-affairs|education|judiciary|parliament|corruption|housing|infrastructure|social|culture|disaster]),
state_changes([{entity,change,from,to,date_reported,date_effective}]),
relationships([{from,relation,to}]),quotes([{speaker,text}] max 2 unnamed=Anonymous),
sentiment([{author,target,lean(positive|negative|neutral),basis}]),sports_crossover(bool).
Rules:
- If a "Byline:" line appears, those are the article authors. Set authors[] to that name. Never put authors in people[].
- people[] = named individuals who are SUBJECTS of the article only.
- name field = given name and surname ONLY. Strip all titles and honorifics from the name field.
  CORRECT: name="Rehanna Ali", role="Magistrate"
  WRONG:   name="Magistrate Rehanna Ali", role=null
- role field = their function in this article. Extract explicitly stated roles first. If not stated, infer:
  presiding/ruled/convicted/acquitted in court -> "Magistrate" or "Judge"
  addressed Parliament/Senate -> "MP" or "Senator"
  prosecuted the case -> "Prosecutor"
  represented accused -> "Defence Attorney"
  police rank (Cpl/Sgt/Insp/PC/Supt/ACP/CoP) -> full rank e.g. "Corporal", "Superintendent"
  medical context -> "Doctor" or specific specialty
  Never leave role null if the article makes their function clear.
- legal_status: accused|charged|convicted|acquitted|wanted — only if explicitly stated about that person.
- state_changes entity = real named person or organization only, never "multiple accused persons" or generic phrases.
- organizations = real named bodies only. Empty=[] Unknown=null. No text outside JSON."""

def gh(path, method="GET", data=None):
    req = urllib.request.Request(f"{GH}/{path}", data=data, method=method, headers=GH_H)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def safe(name):
    return re.sub(r'[<>:"/\\|?*]', '', str(name)).strip()

def wl(name):
    return f"[[{safe(name)}]]"

def fetch_text(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode("utf-8", errors="ignore")
        author_m = re.search(r'itemprop="author"[^>]*>\s*([^\n<]{2,80})', html)
        html_author = author_m.group(1).strip() if author_m else None
        content_m = re.search(r'<div[^>]*id="article-body"[^>]*>([\s\S]+)', html) or \
                   re.search(r'<div[^>]*class="[^"]*asset-content[^"]*"[^>]*>([\s\S]+)', html)
        body_html = content_m.group(1) if content_m else html
        ps = re.findall(r'<p[^>]*>(.*?)</p>', body_html, re.DOTALL)
        clean, seen = [], set()
        for p in ps:
            t = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', p)).strip()
            if len(t) > 60 and t[:80] not in seen:
                seen.add(t[:80]); clean.append(t)
        body = "\n\n".join(clean)[:1600]
        return {"body": body, "html_author": html_author} if body else None
    except:
        return None

def groq_extract(text):
    payload = json.dumps({"model": "qwen/qwen3.6-27b", "temperature": 0, "max_tokens": 1024,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                     {"role": "user", "content": text}]}).encode()
    req = urllib.request.Request(GROQ_URL, data=payload,
        headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    raw = data["choices"][0]["message"]["content"]
    cleaned = re.sub(r'^```json\s*', '', re.sub(r'\s*```$', '', raw.strip())).strip()
    parsed = json.loads(cleaned)
    return parsed[0] if isinstance(parsed, list) else parsed

def build_note(d, url, pub_date):
    date = d.get("date_reported") or pub_date[:10]
    date_eff = d.get("date_effective")
    authors = d.get("authors") or []
    author_set = {a.lower().strip() for a in authors}
    people = [p for p in (d.get("people") or []) if p.get("name") and p["name"].lower().strip() not in author_set]
    orgs = d.get("organizations") or []
    places = d.get("places") or []
    topics = d.get("topics") or []
    lines = ["---",
             f'title: "{(d.get("title") or "Untitled").replace(chr(34), chr(39))}"',
             f"date_reported: {date}",
             f"date_effective: {date_eff or 'null'}",
             "source: trinidadexpress.com",
             f"url: {url}",
             f"authors: [{', '.join(authors)}]",
             f"tags: [{', '.join(topics)}]",
             f"sports_crossover: {str(d.get('sports_crossover', False)).lower()}",
             "---", "",
             f"# {d.get('title') or 'Untitled'}",
             f"> {date} | [trinidadexpress.com]({url})", ""]
    if authors:
        lines += [f"**By:** {' | '.join(f'[[Authors/{safe(a)}|{a}]]' for a in authors)}", ""]
    if people:
        parts = []
        for p in people:
            s = f"[[People/{safe(p['name'])}|{p['name']}]]"
            if p.get("role"): s += f" _({p['role']})_"
            if p.get("legal_status"): s += f" **{p['legal_status']}**"
            parts.append(s)
        lines += ["## People", " | ".join(parts), ""]
    if orgs:
        lines += ["## Organizations", " | ".join(f"[[Orgs/{safe(o)}|{o}]]" for o in orgs), ""]
    if places:
        lines += ["## Places", " | ".join(f"[[Places/{safe(p)}|{p}]]" for p in places), ""]
    if topics:
        lines += ["## Topics", " | ".join(f"[[Topics/{safe(t)}|{t}]]" for t in topics), ""]
    sc = d.get("state_changes") or []
    if sc:
        lines += ["## State Changes", ""]
        for s in sc:
            eff = f" _(effective {s['date_effective']})_" if s.get("date_effective") and s.get("date_effective") != s.get("date_reported") else ""
            lines.append(f"- **{s['entity']}**: {s.get('from') or '?'} -> {s['to']} ({s['change']}){eff}")
        lines.append("")
    rels = d.get("relationships") or []
    if rels:
        lines += ["## Relationships", ""]
        for r in rels:
            lines.append(f"- {wl(r['from'])} **{r['relation']}** {wl(r['to'])}")
        lines.append("")
    quotes = d.get("quotes") or []
    if quotes:
        lines += ["## Key Quotes", ""]
        for q in quotes:
            lines += [f'> "{q["text"]}"', f'> -- {wl(q["speaker"])}', ""]
    sentiment = d.get("sentiment") or []
    if sentiment:
        icons = {"positive": "positive", "negative": "negative", "neutral": "neutral"}
        lines += ["---", "## Sentiment", ""]
        for s in sentiment:
            lines.append(f"- {wl(s['author'])} -> {wl(s['target'])}: **{s['lean']}** -- {s['basis']}")
        lines.append("")
    return "\n".join(lines)

def role_to_tag(role):
    if not role: return "person"
    r = role.lower()
    if any(x in r for x in ["magistrate","judge","master","justice"]): return "judiciary"
    if any(x in r for x in ["defence","defense"]): return "defence"
    if any(x in r for x in ["prosecutor","state attorney","dpp","crown counsel"]): return "prosecution"
    if any(x in r for x in ["mp","senator","minister","prime minister","councillor","chairman"]): return "politics"
    if any(x in r for x in ["corporal","sergeant","inspector","constable","superintendent","commissioner of police","acp","pc ","wpc"]): return "police"
    if any(x in r for x in ["doctor","dr.","physician","surgeon","medical officer","pathologist"]): return "medical"
    if any(x in r for x in ["victim","deceased","complainant"]): return "victim"
    return "person"

def build_person_stub(name, data):
    statuses = list(dict.fromkeys(s["status"] for s in data["statuses"]))
    roles = list(dict.fromkeys(r for r in data["roles"] if r))
    has_criminal = len(statuses) > 0
    role_tags = list(dict.fromkeys(role_to_tag(r) for r in roles)) or ["person"]
    if has_criminal and "criminal-record" not in role_tags:
        role_tags.append("criminal-record")
    tags_str = ", ".join(role_tags)
    lines = ["---", "type: person", f'name: "{safe(name)}"',
             f"roles: [{', '.join(roles)}]",
             f"legal_statuses: [{', '.join(statuses)}]",
             f"tags: [{tags_str}]", "---", "", f"# {name}", ""]
    if roles:
        lines += [f"**Known roles:** {', '.join(roles)}", ""]
    if has_criminal:
        lines += [f"**Legal status:** {', '.join(statuses)}", "", "## Case History", ""]
        for s in data["statuses"]:
            lines.append(f"- **{s['status']}** -- [[{s['article'].replace('.md','')}|{s.get('title','Article')}]] ({s['date']})")
        lines.append("")
    if data.get("articles"):
        lines += ["## Articles", ""]
        for a in data["articles"]:
            title = re.sub(r'^Articles/[\d-]+_', '', a).replace('-', ' ').replace('.md', '')
            lines.append(f"- [[{a.replace('.md','')}|{title}]]")
        lines.append("")
    return "\n".join(lines)

# Main
print("Reading articles from GitHub...")
entries = sorted(gh("contents/Articles"), key=lambda x: x["name"])
print(f"Found {len(entries)} articles\n")

entities = {"People": {}}
files_to_push = {}

for i, entry in enumerate(entries):
    path = entry["path"]
    print(f"[{i+1}/{len(entries)}] {entry['name']}")
    fd = gh(f"contents/{path}")
    content = base64.b64decode(fd["content"].replace("\n", "")).decode()
    url_m = re.search(r'^url: (.+)$', content, re.MULTILINE)
    date_m = re.search(r'^date_reported: (.+)$', content, re.MULTILINE)
    if not url_m:
        print("  skip (no url)"); continue
    url = url_m.group(1).strip()
    pub_date = date_m.group(1).strip() if date_m else "2026-01-01"

    fetched = fetch_text(url)
    if not fetched:
        print("  skip (no text)"); continue

    author_hint = f"Byline: {fetched['html_author']}\n" if fetched.get("html_author") else ""
    try:
        d = groq_extract(f"URL: {url}\nPublished: {pub_date}\n{author_hint}\n{fetched['body']}")
    except Exception as e:
        print(f"  Groq fail: {e}"); time.sleep(5); continue

    files_to_push[path] = build_note(d, url, pub_date)
    authors = d.get("authors") or []
    author_set = {a.lower().strip() for a in authors}
    for p in (d.get("people") or []):
        if not p.get("name") or p["name"].lower().strip() in author_set: continue
        name = p["name"]
        if name not in entities["People"]:
            entities["People"][name] = {"roles": [], "statuses": [], "articles": []}
        ep = entities["People"][name]
        if p.get("role") and p["role"] not in ep["roles"]: ep["roles"].append(p["role"])
        if path not in ep["articles"]: ep["articles"].append(path)
        if p.get("legal_status"):
            if not any(s["article"] == path and s["status"] == p["legal_status"] for s in ep["statuses"]):
                ep["statuses"].append({"status": p["legal_status"], "article": path,
                                       "title": d.get("title", "Article"), "date": d.get("date_reported", pub_date)})
    roles_found = [p.get("role") for p in d.get("people", []) if p.get("role")]
    print(f"  OK -- {len(d.get('people', []))} people, roles: {roles_found[:5]}")
    time.sleep(2)

# Build People stubs for everyone
for name, data in entities["People"].items():
    files_to_push[f"People/{safe(name)}.md"] = build_person_stub(name, data)

files_to_push["data/entities.json"] = json.dumps(entities, indent=2)
print(f"\nPushing {len(files_to_push)} files to GitHub...")

ref = gh("git/refs/heads/main")
head_sha = ref["object"]["sha"]
tree_sha = gh(f"git/commits/{head_sha}")["tree"]["sha"]

tree_items = []
for fpath, fcontent in files_to_push.items():
    blob = gh("git/blobs", "POST", json.dumps({"content": fcontent, "encoding": "utf-8"}).encode())
    tree_items.append({"path": fpath, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    print(f"  {fpath}")

new_tree = gh("git/trees", "POST", json.dumps({"base_tree": tree_sha, "tree": tree_items}).encode())
new_commit = gh("git/commits", "POST", json.dumps({
    "message": "backfill: 70b model, rich People stubs with roles",
    "tree": new_tree["sha"], "parents": [head_sha]}).encode())
gh("git/refs/heads/main", "PATCH", json.dumps({"sha": new_commit["sha"]}).encode())
print(f"\nDone -- commit {new_commit['sha'][:7]}")
