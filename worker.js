/**
 * NewsLink Autonomous Pipeline — Cloudflare Worker
 * Runs hourly. Tracks processed URLs in data/processed.json in the vault repo.
 * Subrequest budget per run (~20, well under free-tier limit of 50):
 *   1 sitemap + 1 processed.json + 3 text + 3 Groq + ~10 GitHub = ~18
 */

const SITEMAP      = "https://trinidadexpress.com/tncms/sitemap/news.xml";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL   = "llama-3.1-8b-instant";
const GH_REPO      = "pmaharaj-cc/newslink-vault";
const GH_BRANCH    = "main";
const TT_OFFSET_MS = -4 * 60 * 60 * 1000;
const MAX_FETCH    = 15;  // articles checked from sitemap per run
const MAX_PROCESS  = 3;   // new articles to process per run
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
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0,300)}`);
  try { return JSON.parse(text); }
  catch(e) { throw new Error(`${label} bad JSON: ${text.slice(0,200)}`); }
}

async function fetchTodayURLs() {
  const res = await fetch(SITEMAP, { headers: {"User-Agent":"Mozilla/5.0"} });
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
  return articles.slice(0, MAX_FETCH);
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(url, { headers: {"User-Agent":"Mozilla/5.0"} });
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
    headers: {"Authorization":`Bearer ${apiKey}`,"Content-Type":"application/json"},
    body: JSON.stringify({
      model: GROQ_MODEL, temperature: 0, max_tokens: 1024,
      messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:articleText}]
    })
  });
  const data = await safeJSON(res, "Groq");
  const raw = data.choices?.[0]?.message?.content || "[]";
  const cleaned = raw.replace(/^```json\s*/,"").replace(/\s*```$/,"").trim();
  try { const p = JSON.parse(cleaned); return Array.isArray(p)?p:[p]; }
  catch(e) { throw new Error(`Groq JSON: ${cleaned.slice(0,200)}`); }
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
  if (dateEff&&dateEff!==date) lines.push(`> ⚠️ **Effective:** ${dateEff} (reported ${date})`, "");
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

function buildDailyNote(date, entries) {
  const links = entries.map(({d,filename})=>`- [[${filename.replace(".md","")}|${d.title||"Untitled"}]]`).join("\n");
  return `# ${date}\n\n## Articles\n\n${links}\n`;
}

async function pushToGitHub(files, token) {
  const base = `https://api.github.com/repos/${GH_REPO}`;
  const headers = {
    "Authorization": `token ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "newslink-worker"
  };
  const refData = await safeJSON(await fetch(`${base}/git/refs/heads/${GH_BRANCH}`,{headers}), "getRef");
  const headSHA = refData.object?.sha;
  if (!headSHA) throw new Error("No HEAD SHA");
  const commitData = await safeJSON(await fetch(`${base}/git/commits/${headSHA}`,{headers}), "getCommit");
  const treeSHA = commitData.tree?.sha;

  const treeItems = [];
  for (const [path, content] of Object.entries(files)) {
    const blob = await safeJSON(
      await fetch(`${base}/git/blobs`,{method:"POST",headers,body:JSON.stringify({content,encoding:"utf-8"})}),
      `blob:${path}`
    );
    treeItems.push({path, mode:"100644", type:"blob", sha:blob.sha});
  }
  const newTree = await safeJSON(
    await fetch(`${base}/git/trees`,{method:"POST",headers,body:JSON.stringify({base_tree:treeSHA,tree:treeItems})}),
    "createTree"
  );
  const today = todayTT();
  const newCommit = await safeJSON(
    await fetch(`${base}/git/commits`,{method:"POST",headers,body:JSON.stringify({
      message:`news: ${today} — ${Object.keys(files).filter(f=>f.startsWith("Articles/")).length} articles`,
      tree:newTree.sha, parents:[headSHA]
    })}),
    "createCommit"
  );
  await safeJSON(
    await fetch(`${base}/git/refs/heads/${GH_BRANCH}`,{method:"PATCH",headers,body:JSON.stringify({sha:newCommit.sha})}),
    "updateRef"
  );
  return newCommit.sha;
}

async function loadProcessed(token) {
  const headers = {"Authorization":`token ${token}`,"Accept":"application/vnd.github.v3+json","User-Agent":"newslink-worker"};
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/processed.json`,{headers});
  if (res.status === 404) return new Set();
  const data = await safeJSON(res, "loadProcessed");
  const urls = JSON.parse(atob(data.content.replace(/\n/g,"")));
  return new Set(urls);
}

async function runPipeline(env) {
  const today = todayTT();
  console.log(`[${today}] Pipeline started`);

  // Load already-processed URLs from GitHub
  const processed = await loadProcessed(env.GITHUB_TOKEN);
  console.log(`Already processed: ${processed.size} URLs`);

  const urlItems = await fetchTodayURLs();
  console.log(`Sitemap: ${urlItems.length} articles today`);

  // Filter to only unprocessed
  const unprocessed = urlItems.filter(a => !processed.has(a.url));
  console.log(`Unprocessed: ${unprocessed.length}`);
  if (!unprocessed.length) { console.log("All done for today"); return; }

  // Process up to MAX_PROCESS new articles
  const toProcess = unprocessed.slice(0, MAX_PROCESS);
  const extracted = [];
  for (let i = 0; i < toProcess.length; i++) {
    const a = toProcess[i];
    const text = await fetchArticleText(a.url);
    if (!text) { processed.add(a.url); continue; }
    const input = `URL: ${a.url}\nPublished: ${a.pubDate}\n\n${text}`;
    try {
      const r = await extractWithGroq(input, env.GROQ_API_KEY);
      const d = r[0];
      if (d) extracted.push({result:d, src:a});
      processed.add(a.url);
    } catch(e) { console.log(`Failed: ${e.message}`); }
    if (i + 1 < toProcess.length) await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`Extracted: ${extracted.length}`);
  if (!extracted.length) return;

  // Build files
  const files = {};
  const articleEntries = [];
  for (const {result:d, src} of extracted) {
    const filename = `Articles/${(d.date_reported||src.pubDate.slice(0,10))}_${(d.title||"untitled").replace(/[^\w\s-]/g,"").trim().slice(0,55).replace(/\s+/g,"-")}.md`;
    files[filename] = buildNote(d, src.url, src.pubDate);
    articleEntries.push({d, filename});
  }
  files[`Daily/${today}.md`] = buildDailyNote(today, articleEntries);
  files["data/processed.json"] = JSON.stringify([...processed], null, 2);

  const sha = await pushToGitHub(files, env.GITHUB_TOKEN);
  console.log(`Pushed ${extracted.length} articles — commit ${sha.slice(0,7)}`);
}

export default {
  async fetch(request, env) {
    const {pathname, searchParams} = new URL(request.url);
    if (pathname === "/run" && searchParams.get("secret") === env.TRIGGER_SECRET) {
      try { await runPipeline(env); return new Response("Pipeline complete", {status:200}); }
      catch(e) { return new Response(`Error: ${e.message}`, {status:500}); }
    }
    return new Response("NewsLink running.", {status:200});
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runPipeline(env)); }
};
