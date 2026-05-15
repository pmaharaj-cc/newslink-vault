/**
 * NewsLink Autonomous Pipeline — Cloudflare Worker
 * Env vars: GROQ_API_KEY, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH, TRIGGER_SECRET
 */

const SITEMAP      = "https://trinidadexpress.com/tncms/sitemap/news.xml";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL   = "llama-3.1-8b-instant";
const TT_OFFSET_MS = -4 * 60 * 60 * 1000;
const MAX_ARTICLES = 10;
const TEXT_LIMIT   = 800;

const SYSTEM_PROMPT = `Extract Trinidad news. Return JSON array only. One object per article. Fields:
title,authors([str]),date_reported(YYYY-MM-DD),date_effective(YYYY-MM-DD|null),
people([{name,role}]),organizations([str]),places([str]),
topics([economy|crime|government|health|environment|energy|foreign-affairs|education|judiciary|parliament|corruption|housing|infrastructure|social|culture|disaster]),
state_changes([{entity,change,from,to,date_reported,date_effective}]),
relationships([{from,relation,to}]),quotes([{speaker,text}] max 2 unnamed=Anonymous),
sentiment([{author,target,lean(positive|negative|neutral),basis}]),sports_crossover(bool).
Empty=[] Unknown=null. No text outside JSON.`;

function todayTT() {
  return new Date(Date.now() + TT_OFFSET_MS).toISOString().slice(0, 10);
}

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim().replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"') : "";
}

function safe(name) { return String(name).replace(/[<>:"/\\|?*]/g,"").trim(); }
function wl(name)   { return `[[${safe(name)}]]`; }

async function safeJSON(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); }
  catch(e) { throw new Error(`${label} JSON parse failed (${res.status}): ${text.slice(0, 200)}`); }
}

async function fetchTodayURLs() {
  const res = await fetch(SITEMAP, { headers: { "User-Agent": "Mozilla/5.0" } });
  const xml = await res.text();
  const today = todayTT();
  const seen = new Set();
  const articles = [];
  for (const block of (xml.match(/<url>[\s\S]*?<\/url>/g) || [])) {
    const url = xmlTag(block, "loc");
    const pub = xmlTag(block, "news:publication_date");
    if (!url || seen.has(url)) continue;
    if (!pub.startsWith(today)) continue;
    if (url.includes("/sports/")) continue;
    seen.add(url);
    articles.push({ url, pubDate: pub });
  }
  return articles.slice(0, MAX_ARTICLES);
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    const ps = (html.match(/<p[^>]*>[\s\S]*?<\/p>/g) || [])
      .map(p => p.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim())
      .filter(p => p.length > 60);
    const seen = new Set();
    const unique = ps.filter(p => { const k=p.slice(0,80); return seen.has(k)?false:!!seen.add(k); });
    const full = unique.join("\n\n");
    return full ? full.slice(0, TEXT_LIMIT) : null;
  } catch(e) { return null; }
}

async function extractWithGroq(articleText, apiKey) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL, temperature: 0, max_tokens: 1024,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: articleText }
      ]
    })
  });
  const data = await safeJSON(res, "Groq");
  const raw = data.choices?.[0]?.message?.content || "[]";
  const cleaned = raw.replace(/^```json\s*/,"").replace(/\s*```$/,"").trim();
  try { const p = JSON.parse(cleaned); return Array.isArray(p) ? p : [p]; }
  catch(e) { throw new Error(`Groq JSON parse: ${cleaned.slice(0, 200)}`); }
}

function buildNote(d, url, pubDate) {
  const date=d.date_reported||pubDate.slice(0,10), dateEff=d.date_effective, authors=d.authors||[];
  const lines = [
    "---",
    `title: "${(d.title||"Untitled").replace(/"/g,"'")}"`,
    `date_reported: ${date}`, `date_effective: ${dateEff||"null"}`,
    `source: trinidadexpress.com`, `url: ${url}`,
    `authors: [${authors.join(", ")}]`, `tags: [${(d.topics||[]).join(", ")}]`,
    `sports_crossover: ${d.sports_crossover||false}`, "---", "",
    `# ${d.title||"Untitled"}`, `> ${date} · trinidadexpress.com · [link](${url})`, "",
  ];
  if (authors.length) lines.push(`**By:** ${authors.map(a=>`[[Authors/${safe(a)}|${a}]]`).join(" · ")}`, "");
  if (dateEff && dateEff!==date) lines.push(`> ⚠️ **Effective:** ${dateEff} (reported ${date})`, "");
  const people=d.people||[],orgs=d.organizations||[],places=d.places||[],topics=d.topics||[];
  if (people.length) lines.push("## People",people.map(p=>`[[People/${safe(p.name)}|${p.name}]]`).join(" · "),"");
  if (orgs.length)   lines.push("## Organizations",orgs.map(o=>`[[Orgs/${safe(o)}|${o}]]`).join(" · "),"");
  if (places.length) lines.push("## Places",places.map(p=>`[[Places/${safe(p)}|${p}]]`).join(" · "),"");
  if (topics.length) lines.push("## Topics",topics.map(t=>`[[Topics/${safe(t)}|${t}]]`).join(" · "),"");
  const sc=d.state_changes||[];
  if (sc.length) {
    lines.push("## State Changes","");
    for (const s of sc) {
      const eff=s.date_effective&&s.date_effective!==s.date_reported?` _(effective ${s.date_effective})_`:"";
      lines.push(`- ${wl(s.entity)}: **${s.from||"?"}** → **${s.to}** _${s.change}_${eff}`);
    }
    lines.push("");
  }
  const rels=d.relationships||[];
  if (rels.length) { lines.push("## Relationships",""); for (const r of rels) lines.push(`- ${wl(r.from)} **${r.relation}** ${wl(r.to)}`); lines.push(""); }
  const quotes=d.quotes||[];
  if (quotes.length) { lines.push("## Key Quotes",""); for (const q of quotes) { lines.push(`> "${q.text}"`,`> — ${wl(q.speaker)}`,""); } }
  const sentiment=d.sentiment||[];
  if (sentiment.length) {
    lines.push("---","## Sentiment","");
    const icons={positive:"🟢",negative:"🔴",neutral:"⚪"};
    for (const s of sentiment) lines.push(`- ${wl(s.author)} → ${wl(s.target)}: ${icons[s.lean]||"⚪"} **${s.lean}** — _${s.basis}_`);
    lines.push("");
  }
  return lines.join("\n");
}

function articleFilename(d, pubDate) {
  const date=d.date_reported||pubDate.slice(0,10);
  const slug=(d.title||"untitled").replace(/[^\w\s-]/g,"").trim().slice(0,55).replace(/\s+/g,"-");
  return `Articles/${date}_${slug}.md`;
}

function buildDailyNote(date, entries) {
  const links=entries.map(({d,filename})=>`- [[${filename.replace(".md","")}|${d.title||"Untitled"}]]`).join("\n");
  return `# ${date}\n\n## Articles\n\n${links}\n`;
}

function buildEntityStub(name, type) {
  return `---\ntype: ${type}\nname: ${name}\n---\n\n# ${name}\n\n## Articles\n\n`;
}

async function pushToGitHub(files, token, repo, branch) {
  const repo2=(repo||"").trim(), branch2=(branch||"main").trim();
  const base=`https://api.github.com/repos/${repo2}`;
  const headers={"Authorization":`token ${token}`,"Content-Type":"application/json","Accept":"application/vnd.github.v3+json","User-Agent":"newslink-worker"};

  const refRes = await fetch(`${base}/git/refs/heads/${branch2}`, {headers});
  const refData = await safeJSON(refRes, "GitHub getRef");
  const headSHA = refData.object?.sha;
  if (!headSHA) throw new Error("Could not get HEAD SHA");

  const commitRes = await fetch(`${base}/git/commits/${headSHA}`, {headers});
  const commitData = await safeJSON(commitRes, "GitHub getCommit");
  const treeSHA = commitData.tree?.sha;

  const treeItems = await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const blobRes = await fetch(`${base}/git/blobs`, {method:"POST",headers,body:JSON.stringify({content,encoding:"utf-8"})});
    const blob = await safeJSON(blobRes, `GitHub blob:${path}`);
    return {path, mode:"100644", type:"blob", sha:blob.sha};
  }));

  const newTreeRes = await fetch(`${base}/git/trees`, {method:"POST",headers,body:JSON.stringify({base_tree:treeSHA,tree:treeItems})});
  const newTree = await safeJSON(newTreeRes, "GitHub createTree");

  const today = todayTT();
  const newCommitRes = await fetch(`${base}/git/commits`, {method:"POST",headers,body:JSON.stringify({
    message:`news: ${today} — ${Object.keys(files).filter(f=>f.startsWith("Articles/")).length} articles`,
    tree:newTree.sha, parents:[headSHA]
  })});
  const newCommit = await safeJSON(newCommitRes, "GitHub createCommit");

  const patchRes = await fetch(`${base}/git/refs/heads/${branch2}`, {method:"PATCH",headers,body:JSON.stringify({sha:newCommit.sha})});
  await safeJSON(patchRes, "GitHub updateRef");

  return newCommit.sha;
}

async function runPipeline(env) {
  const today = todayTT();
  console.log(`[${today}] Pipeline started`);
  const urlItems = await fetchTodayURLs();
  console.log(`Found ${urlItems.length} articles`);
  if (!urlItems.length) return;

  const fetched = await Promise.all(urlItems.map(async item => ({...item, text: await fetchArticleText(item.url)})));
  const withText = fetched.filter(a => a.text);
  console.log(`Text fetched: ${withText.length}/${fetched.length}`);

  const extracted = [];
  for (let i = 0; i < withText.length; i++) {
    const a = withText[i];
    const input = `URL: ${a.url}\nPublished: ${a.pubDate}\n\n${a.text}`;
    try {
      const r = await extractWithGroq(input, env.GROQ_API_KEY);
      extracted.push({result: r[0], src: a});
    } catch(e) { console.log(`Article ${i+1} failed: ${e.message}`); }
    if (i + 1 < withText.length) await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`Extracted ${extracted.length} articles`);

  const files = {}, articleEntries = [], newEntities = new Set();
  for (const {result: d, src} of extracted) {
    if (!d) continue;
    const filename = articleFilename(d, src.pubDate);
    files[filename] = buildNote(d, src.url, src.pubDate);
    articleEntries.push({d, filename});
    for (const p of (d.people||[]))        newEntities.add(`People/${safe(p.name)}|person|${p.name}`);
    for (const o of (d.organizations||[])) newEntities.add(`Orgs/${safe(o)}|organization|${o}`);
    for (const pl of (d.places||[]))       newEntities.add(`Places/${safe(pl)}|place|${pl}`);
    for (const t of (d.topics||[]))        newEntities.add(`Topics/${safe(t)}|topic|${t}`);
    for (const a of (d.authors||[]))       newEntities.add(`Authors/${safe(a)}|author|${a}`);
  }
  if (!articleEntries.length) { console.log("No articles extracted"); return; }

  files[`Daily/${today}.md`] = buildDailyNote(today, articleEntries);
  for (const entry of newEntities) {
    const parts = entry.split("|");
    files[`Entities/${parts[0]}.md`] = buildEntityStub(parts[2], parts[1]);
  }

  const sha = await pushToGitHub(files, env.GITHUB_TOKEN, "pmaharaj-cc/newslink-vault", "main");
  console.log(`Pushed ${Object.keys(files).length} files — commit ${sha.slice(0,7)}`);
}

export default {
  async fetch(request, env) {
    const {pathname, searchParams} = new URL(request.url);
    if (pathname === "/run" && searchParams.get("secret") === env.TRIGGER_SECRET) {
      try { await runPipeline(env); return new Response("Pipeline complete", {status:200}); }
      catch(e) { return new Response(`Error: ${e.message}`, {status:500}); }
    }
    return new Response("NewsLink Worker running.", {status:200});
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runPipeline(env)); }
};
