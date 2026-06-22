"""
NewsLink Catch-up — process unprocessed sitemap articles (multi-day lookback).
Run via GitHub Actions or locally with GITHUB_TOKEN and GROQ_API_KEY set.
"""
import json, base64, re, time, os, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOKEN = os.environ.get("GITHUB_TOKEN", "")
GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
REPO = "pmaharaj-cc/newslink-vault"
BRANCH = "main"
GH = f"https://api.github.com/repos/{REPO}"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.environ.get("GROQ_MODEL", "qwen/qwen3.6-27b")
SITEMAP = "https://trinidadexpress.com/tncms/sitemap/news.xml"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "21"))
MAX_PROCESS = int(os.environ.get("MAX_PROCESS", "25"))
TEXT_LIMIT = 1600
TT = timezone(timedelta(hours=-4))

GH_H = {
    "Authorization": f"token {TOKEN}",
    "User-Agent": "newslink-catchup",
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
}

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
- role field = their function in this article. Infer from context when clear.
- legal_status: accused|charged|convicted|acquitted|wanted — only if explicitly stated.
- state_changes entity = real named person or organization only.
- organizations = real named bodies only. Empty=[] Unknown=null. No text outside JSON."""


def gh(path, method="GET", data=None):
    req = urllib.request.Request(f"{GH}/{path}", data=data, method=method, headers=GH_H)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def safe(name):
    return re.sub(r'[<>:"/\\|?*]', '', str(name)).strip()


def wl(name):
    return f"[[{safe(name)}]]"


def today_tt():
    return datetime.now(TT).strftime("%Y-%m-%d")


def cutoff_date():
    return (datetime.now(TT) - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")


def xml_tag(block, tag):
    m = re.search(rf"<{tag}[^>]*>([\s\S]*?)</{tag}>", block)
    if not m:
        return ""
    return m.group(1).strip().replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')


def fetch_sitemap_urls():
    req = urllib.request.Request(SITEMAP, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        xml = r.read().decode("utf-8", errors="ignore")
    cutoff = cutoff_date()
    seen, articles = set(), []
    for block in re.findall(r"<url>[\s\S]*?</url>", xml):
        url = xml_tag(block, "loc")
        pub = xml_tag(block, "news:publication_date")
        if not url or url in seen:
            continue
        if not pub or pub[:10] < cutoff:
            continue
        if "/sports/" in url:
            continue
        seen.add(url)
        articles.append({"url": url, "pubDate": pub})
    articles.sort(key=lambda a: a["pubDate"], reverse=True)
    return articles


def fetch_article_text(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode("utf-8", errors="ignore")
        author_m = re.search(r'itemprop="author"[^>]*>\s*([^\n<]{2,80})', html)
        html_author = author_m.group(1).strip() if author_m else None
        body_m = re.search(r'<div[^>]*id="article-body"[^>]*>([\s\S]+)', html) or \
                 re.search(r'<div[^>]*class="[^"]*asset-content[^"]*"[^>]*>([\s\S]+)', html)
        body_html = body_m.group(1) if body_m else html
        ps = re.findall(r'<p[^>]*>(.*?)</p>', body_html, re.DOTALL)
        clean, seen = [], set()
        for p in ps:
            t = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', p)).strip()
            if len(t) > 60 and t[:80] not in seen:
                seen.add(t[:80])
                clean.append(t)
        body = "\n\n".join(clean)[:TEXT_LIMIT]
        return {"body": body, "html_author": html_author} if body else None
    except Exception:
        return None


def groq_extract(text):
    payload = json.dumps({
        "model": GROQ_MODEL, "temperature": 0, "max_tokens": 1024,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": text}]
    }).encode()
    req = urllib.request.Request(GROQ_URL, data=payload,
        headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")[:300]
        raise RuntimeError(f"Groq HTTP {e.code}: {body}") from e
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
    lines = [
        "---",
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
        f"> {date} · trinidadexpress.com · [link]({url})", ""
    ]
    if authors:
        lines += [f"**By:** {' · '.join(f'[[Authors/{safe(a)}|{a}]]' for a in authors)}", ""]
    if date_eff and date_eff != date:
        lines += [f"> ⚠️ **Effective:** {date_eff} (reported {date})", ""]
    if people:
        parts = []
        for p in people:
            s = f"[[People/{safe(p['name'])}|{p['name']}]]"
            if p.get("role"):
                s += f" _({p['role']})_"
            if p.get("legal_status"):
                s += f" ⚠️ _{p['legal_status']}_"
            parts.append(s)
        lines += ["## People", " · ".join(parts), ""]
    if orgs:
        lines += ["## Organizations", " · ".join(f"[[Orgs/{safe(o)}|{o}]]" for o in orgs), ""]
    if places:
        lines += ["## Places", " · ".join(f"[[Places/{safe(p)}|{p}]]" for p in places), ""]
    if topics:
        lines += ["## Topics", " · ".join(f"[[Topics/{safe(t)}|{t}]]" for t in topics), ""]
    sc = d.get("state_changes") or []
    if sc:
        lines += ["## State Changes", ""]
        for s in sc:
            eff = f" _(effective {s['date_effective']})_" if s.get("date_effective") and s.get("date_effective") != s.get("date_reported") else ""
            lines.append(f"- {wl(s['entity'])}: **{s.get('from') or '?'}** → **{s['to']}** _{s['change']}_{eff}")
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
            lines += [f'> "{q["text"]}"', f'> — {wl(q["speaker"])}', ""]
    sentiment = d.get("sentiment") or []
    if sentiment:
        icons = {"positive": "🟢", "negative": "🔴", "neutral": "⚪"}
        lines += ["---", "## Sentiment", ""]
        for s in sentiment:
            lines.append(f"- {wl(s['author'])} → {wl(s['target'])}: {icons.get(s['lean'], '⚪')} **{s['lean']}** — _{s['basis']}_")
        lines.append("")
    return "\n".join(lines)


def build_person_stub(name, data):
    statuses = list(dict.fromkeys(s["status"] for s in data["statuses"]))
    roles = list(dict.fromkeys(r for r in data["roles"] if r))
    has_criminal = len(statuses) > 0
    tags = "tags: [criminal-record]" if has_criminal else "tags: []"
    lines = [
        "---", "type: person", f'name: "{safe(name)}"',
        f"roles: [{', '.join(roles)}]",
        f"legal_statuses: [{', '.join(statuses)}]",
        tags, "---", "", f"# {name}", ""
    ]
    if roles:
        lines += [f"**Known roles:** {', '.join(roles)}", ""]
    if has_criminal:
        lines += [f"**Legal status:** {', '.join(statuses)}", "", "## Case History", ""]
        for s in data["statuses"]:
            lines.append(f"- **{s['status']}** — [[{s['article'].replace('.md', '')}|{s.get('title', 'Article')}]] _({s['date']})_")
        lines.append("")
    if data.get("articles"):
        lines += ["## Articles", ""]
        for a in data["articles"]:
            title = re.sub(r'^Articles/[\d-]+_', '', a).replace('-', ' ').replace('.md', '')
            lines.append(f"- [[{a.replace('.md', '')}|{title}]]")
        lines.append("")
    return "\n".join(lines)


def article_filename(d, pub_date):
    date = d.get("date_reported") or pub_date[:10]
    slug = re.sub(r'[^\w\s-]', '', d.get("title") or "untitled").strip()[:55].replace(" ", "-")
    return f"Articles/{date}_{slug}.md"


def build_daily_note(date, entries):
    by_file = {}
    for item in entries:
        by_file[item["filename"]] = item
    sorted_items = sorted(by_file.values(), key=lambda x: x["filename"])
    links = "\n".join(f"- [[{x['filename'].replace('.md', '')}|{x['title']}]]" for x in sorted_items)
    return f"# {date}\n\n## Articles\n\n{links}\n"


def load_processed():
    try:
        data = gh("contents/data/processed.json")
        return set(json.loads(base64.b64decode(data["content"].replace("\n", "")).decode()))
    except Exception:
        return set()


def load_vault_urls():
    """Prefer local checkout (fast); fall back to GitHub API."""
    urls = set()
    articles_dir = Path("Articles")
    if articles_dir.is_dir():
        for path in articles_dir.glob("*.md"):
            try:
                for line in path.read_text(encoding="utf-8").splitlines():
                    if line.startswith("url: "):
                        u = line.split("url: ", 1)[1].strip()
                        if u:
                            urls.add(u)
                        break
            except Exception:
                continue
        print(f"Scanned {len(urls)} URLs from local Articles/")
        return urls

    try:
        items = gh(f"contents/Articles?ref={BRANCH}")
        if not isinstance(items, list):
            return urls
        for item in items:
            if not item["name"].endswith(".md"):
                continue
            try:
                fd = gh(f"contents/Articles/{item['name']}")
                content = base64.b64decode(fd["content"].replace("\n", "")).decode()
                m = re.search(r"^url: (.+)$", content, re.MULTILINE)
                if m:
                    urls.add(m.group(1).strip())
            except Exception:
                continue
    except Exception as e:
        print(f"warn: could not scan Articles/: {e}")
    return urls


def load_entities():
    try:
        data = gh("contents/data/entities.json")
        entities = json.loads(base64.b64decode(data["content"].replace("\n", "")).decode())
        if "People" not in entities:
            entities["People"] = {}
        return entities
    except Exception:
        return {"People": {}}


def list_articles_for_date(date, new_entries):
    merged = {e["filename"]: e for e in new_entries}
    prefix = f"{date}_"
    articles_dir = Path("Articles")
    if articles_dir.is_dir():
        for path in sorted(articles_dir.glob(f"{prefix}*.md")):
            fn = f"Articles/{path.name}"
            if fn in merged:
                continue
            try:
                content = path.read_text(encoding="utf-8")
                title_m = re.search(r'^title: "(.+)"$', content, re.MULTILINE)
                title = title_m.group(1) if title_m else path.stem[len(date) + 1:].replace("-", " ")
                merged[fn] = {"filename": fn, "title": title}
            except Exception:
                continue
        return list(merged.values())

    try:
        items = gh(f"contents/Articles?ref={BRANCH}")
        if isinstance(items, list):
            for item in items:
                if not item["name"].startswith(prefix):
                    continue
                fn = f"Articles/{item['name']}"
                if fn in merged:
                    continue
                fd = gh(f"contents/{fn}")
                content = base64.b64decode(fd["content"].replace("\n", "")).decode()
                title_m = re.search(r'^title: "(.+)"$', content, re.MULTILINE)
                title = title_m.group(1) if title_m else item["name"][len(prefix):].replace("-", " ")
                merged[fn] = {"filename": fn, "title": title}
    except Exception as e:
        print(f"  warn: could not list existing articles for {date}: {e}")
    return list(merged.values())


def main():
    if not TOKEN or not GROQ_KEY:
        raise SystemExit("GITHUB_TOKEN and GROQ_API_KEY required")

    print(f"Catch-up since {cutoff_date()} (max {MAX_PROCESS} articles)")
    processed = load_processed()
    vault_urls = load_vault_urls()
    entities = load_entities()
    candidates = fetch_sitemap_urls()
    # Vault article files are source of truth — ignore ghost entries in processed.json
    pending = [a for a in candidates if a["url"] not in vault_urls]
    ghosts = processed - vault_urls
    print(f"Sitemap: {len(candidates)} recent, {len(pending)} missing from vault")
    if ghosts:
        print(f"Cleaning {len(ghosts)} ghost processed URLs (no article file)")
    processed = vault_urls

    if not pending:
        print("Nothing to catch up.")
        return

    files = {}
    entries_by_date = {}
    batch = pending[:MAX_PROCESS]
    extracted = 0

    for i, article in enumerate(batch):
        print(f"[{i+1}/{len(batch)}] {article['url']}")
        fetched = fetch_article_text(article["url"])
        if not fetched:
            print("  skip (no text)")
            continue
        author_hint = f"Byline: {fetched['html_author']}\n" if fetched.get("html_author") else ""
        try:
            d = groq_extract(f"URL: {article['url']}\nPublished: {article['pubDate']}\n{author_hint}\n{fetched['body']}")
        except Exception as e:
            print(f"  Groq fail: {e}")
            time.sleep(5)
            continue

        fn = article_filename(d, article["pubDate"])
        date = d.get("date_reported") or article["pubDate"][:10]
        files[fn] = build_note(d, article["url"], article["pubDate"])
        if date not in entries_by_date:
            entries_by_date[date] = []
        entries_by_date[date].append({"filename": fn, "title": d.get("title") or "Untitled"})
        processed.add(article["url"])
        extracted += 1

        authors = d.get("authors") or []
        author_set = {a.lower().strip() for a in authors}
        for p in (d.get("people") or []):
            if not p.get("name") or p["name"].lower().strip() in author_set:
                continue
            name = p["name"]
            if name not in entities["People"]:
                entities["People"][name] = {"roles": [], "statuses": [], "articles": []}
            ep = entities["People"][name]
            if p.get("role") and p["role"] not in ep["roles"]:
                ep["roles"].append(p["role"])
            if fn not in ep["articles"]:
                ep["articles"].append(fn)
            if p.get("legal_status"):
                if not any(s["article"] == fn and s["status"] == p["legal_status"] for s in ep["statuses"]):
                    ep["statuses"].append({
                        "status": p["legal_status"], "article": fn,
                        "title": d.get("title", "Article"), "date": date
                    })
        print(f"  OK — {d.get('title', 'Untitled')[:60]}")
        time.sleep(2)

    if extracted:
        for date, entries in entries_by_date.items():
            merged = list_articles_for_date(date, entries)
            files[f"Daily/{date}.md"] = build_daily_note(date, merged)
        files["data/entities.json"] = json.dumps(entities, indent=2)
        for name, data in entities["People"].items():
            if data.get("statuses"):
                files[f"People/{safe(name)}.md"] = build_person_stub(name, data)
    elif not ghosts:
        print("No articles extracted.")
        return

    files["data/processed.json"] = json.dumps(sorted(processed), indent=2)

    if not files:
        print("Nothing to push.")
        return

    print(f"\nPushing {len(files)} files ({extracted} new articles)...")
    ref = gh(f"git/refs/heads/{BRANCH}")
    head_sha = ref["object"]["sha"]
    tree_sha = gh(f"git/commits/{head_sha}")["tree"]["sha"]
    tree_items = []
    for fpath, fcontent in files.items():
        blob = gh("git/blobs", "POST", json.dumps({"content": fcontent, "encoding": "utf-8"}).encode())
        tree_items.append({"path": fpath, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    new_tree = gh("git/trees", "POST", json.dumps({"base_tree": tree_sha, "tree": tree_items}).encode())
    msg = f"catchup: {today_tt()} — {extracted} articles"
    new_commit = gh("git/commits", "POST", json.dumps({
        "message": msg, "tree": new_tree["sha"], "parents": [head_sha]
    }).encode())
    gh(f"git/refs/heads/{BRANCH}", "PATCH", json.dumps({"sha": new_commit["sha"]}).encode())
    print(f"Done — {new_commit['sha'][:7]} ({extracted} articles)")


if __name__ == "__main__":
    main()