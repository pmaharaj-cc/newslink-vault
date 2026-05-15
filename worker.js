/**
 * NewsLink Autonomous Pipeline — Cloudflare Worker
 * Env vars: GROQ_API_KEY, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH, TRIGGER_SECRET
 */

const SITEMAP      = "https://trinidadexpress.com/tncms/sitemap/news.xml";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL   = "llama-3.1-8b-instant";
const TT_OFFSET_MS = -4 * 60 * 60 * 1000;
const MAX_ARTICLES = 1;
const GROQ_BATCH   = 1;

const SYSTEM_PROMPT = `Extract Trinidad news. Return JSON array only. Fields: title(str), authors([str]), date_reported(YYYY-MM-DD), date_effective(YYYY-MM-DD|null), people([{name,role}]), organizations([str]), places([str]), topics([economy|crime|government|health|environment|energy|foreign-affairs|education|judiciary|parliament|corruption|housing|infrastructure|social|culture|disaster]), state_changes([{entity,change,from,to,date_reported,date_effective}]), relationships([{from,relation,to}]), quotes([{speaker,text}] max 2, unnamed="Anonymous"), sentiment([{author,target,lean(positive|negative|neutral),basis}]), sports_crossover(bool). No text outside JSON.`;

function todayTT() {
  return new Date(Date.now() + TT_OFFSET_MS).toISOString().slice(0, 10);
}

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim().replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"') : "";
}

function safe(name) { return String(name).replace(/[<>:"/\\|?*]/g,"").trim(); }
function wl(name) { return `[[${safe(name)}]]`; }

async function fetchTodayURLs() {
  const res = await fetch(SITEMAP, { headers: {"User-Agent":"Mozilla/5.0"} });
  const xml = await res.text();
  const today = todayTT();
  const seen = new Set();
  const articles = [];
  for (const block of (xml.match(/<url>[\s\S]*?<\/url>/g) || [])) {
    const url = xmlTag(block, "loc");
    const pub = xmlTag(block, "news:publication_date");
    if (!url || seen.has(url) || !pub.startsWith(today) || url.includes("/sports/")) continue;
    seen.add(url);
    articles.push({ url, pubDate: pub });
  }
  return articles.slice(0, MAX_ARTICLES);
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
    const full=ps.filter(p => { const k=p.slice(0,80); return seen.has(k)?false:!!seen.add(k); }).join("\n\n"); return full.slice(0,1500) || null;
  } catch(e) { return null; }
}

async function extractWithGroq(text, apiKey) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {"Authorization":`Bearer ${apiKey}`,"Content-Type":"application/json"},
    body: JSON.stringify({ model:GROQ_MODEL, temperature:0, max_tokens:4096,
      messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:text}] })
  });
  if (!res.ok) { const e=await res.text(); throw new Error(`Groq ${res.status}: ${e.slice(0,200)}`); }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "[]";
  const cleaned = raw.replace(/^```json\s*/,"").replace(/\s*```$/,"").trim();
  try { return JSON.parse(cleaned); } catch(e) { throw new Error(`JSON parse failed: ${cleaned.slice(0,200)}`); }
}

function buildNote(d, url, pubDate) {
  const date=d.date_reported||pubDate.slice(0,10), dateEff=d.date_effective, authors=d.authors||[];
  const lines=["---",
    `title: "${(d.title||"Untitled").replace(/"/g,"'")}"`,
    `date_reported: ${date}`,`date_effective: ${dateEff||"null"}`,
    `source: trinidadexpress.com`,`url: ${url}`,
    `authors: [${authors.join(", ")}]`,`tags: [${(d.topics||[]).join(", ")}]`,
    `sports_crossover: ${d.sports_crossover||false}`,"---","",
    `# ${d.title||"Untitled"}`,`> ${date} · trinidadexpress.com · [link](${url})`,""];
  if (authors.length) lines.push(`**By:** ${authors.map(a=>`[[Authors/${safe(a)}|${a}]]`).join(" · ")}`, "");
  if (dateEff && dateEff!==date) lines.push(`> ⚠️ **Effective:** ${dateEff} (reported ${date})`, "");
  const people=d.people||[], orgs=d.organizations||[], places=d.places||[], topics=d.topics||[];
  if (people.length) lines.push("## People", people.map(p=>`[[People/${safe(p.name)}|${p.name}]]`).join(" · "),"");
  if (orgs.length)   lines.push("## Organizations", orgs.map(o=>`[[Orgs/${safe(o)}|${o}]]`).join(" · "),"");
  if (places.length) lines.push("## Places", places.map(p=>`[[Places/${safe(p)}|${p}]]`).join(" · "),"");
  if (topics.length) lines.push("## Topics", topics.map(t=>`[[Topics/${safe(t)}|${t}]]`).join(" · "),"");
  const sc=d.state_changes||[];
  if (sc.length) { lines.push("## State Changes",""); for (const s of sc) { const eff=s.date_effective&&s.date_effective!==s.date_reported?` _(effective ${s.date_effective})_`:""; lines.push(`- ${wl(s.entity)}: **${s.from||"?"}** → **${s.to}** _${s.change}_${eff}`); } lines.push(""); }
  const rels=d.relationships||[];
  if (rels.length) { lines.push("## Relationships",""); for (const r of rels) lines.push(`- ${wl(r.from)} **${r.relation}** ${wl(r.to)}`); lines.push(""); }
  const quotes=d.quotes||[];
  if (quotes.length) { lines.push("## Key Quotes",""); for (const q of quotes) lines.push(`> "${q.text}"`,`> — ${wl(q.speaker)}`,""); }
  const sentiment=d.sentiment||[];
  if (sentiment.length) { lines.push("---","## Sentiment",""); const icons={positive:"🟢",negative:"🔴",neutral:"⚪"}; for (const s of sentiment) lines.push(`- ${wl(s.author)} → ${wl(s.target)}: ${icons[s.lean]||"⚪"} **${s.lean}** — _${s.basis}_`); lines.push(""); }
  return lines.join("\n");
}

function articleFilename(d, pubDate) {
  const date=d.date_reported||pubDate.slice(0,10);
  const slug=(d.title||"untitled").replace(/[^\w\s-]/g,"").trim().slice(0,55).replace(/\s+/g,"-");
  return `Articles/${date}_${slug}.md`;
}

function buildDailyNote(date, entries) {
  return `# ${date}\n\n## Articles\n\n${entries.map(({d,filename})=>`- [[${filename.replace(".md","")}|${d.title||"Untitled"}]]`).join("\n")}\n`;
}

function buildEntityStub(name, type) {
  return `---\ntype: ${type}\nname: ${name}\n---\n\n# ${name}\n\n## Articles\n\n`;
}

async function pushToGitHub(files, token, repo, branch) {
  const base=`https://api.github.com/repos/${repo}`;
  const h={"Authorization":`token ${token}`,"Content-Type":"application/json","Accept":"application/vnd.github.v3+json"};
  const refData=await(await fetch(`${base}/git/refs/heads/${branch}`,{headers:h})).json();
  const headSHA=refData.object?.sha;
  if (!headSHA) throw new Error("Could not get HEAD SHA");
  const commitData=await(await fetch(`${base}/git/commits/${headSHA}`,{headers:h})).json();
  const treeSHA=commitData.tree?.sha;
  const treeItems=await Promise.all(Object.entries(files).map(async([path,content])=>{
    const blob=await(await fetch(`${base}/git/blobs`,{method:"POST",headers:h,body:JSON.stringify({content,encoding:"utf-8"})})).json();
    return {path,mode:"100644",type:"blob",sha:blob.sha};
  }));
  const newTree=await(await fetch(`${base}/git/trees`,{method:"POST",headers:h,body:JSON.stringify({base_tree:treeSHA,tree:treeItems})})).json();
  const today=todayTT();
  const newCommit=await(await fetch(`${base}/git/commits`,{method:"POST",headers:h,body:JSON.stringify({message:`news: ${today} — ${Object.keys(files).filter(f=>f.startsWith("Articles/")).length} articles`,tree:newTree.sha,parents:[headSHA]})})).json();
  await fetch(`${base}/git/refs/heads/${branch}`,{method:"PATCH",headers:h,body:JSON.stringify({sha:newCommit.sha})});
  return newCommit.sha;
}

async function runPipeline(env) {
  const today=todayTT();
  console.log(`[${today}] Pipeline started`);
  const urlItems=await fetchTodayURLs();
  console.log(`Found ${urlItems.length} articles`);
  if (!urlItems.length) return;
  const fetched=await Promise.all(urlItems.map(async item=>({...item,text:await fetchArticleText(item.url)})));
  const withText=fetched.filter(a=>a.text);
  console.log(`Text fetched: ${withText.length}/${fetched.length}`);
  const extracted=[];
  for (let i=0;i<withText.length;i+=GROQ_BATCH) {
    const batch=withText.slice(i,i+GROQ_BATCH);
    const input=batch.map((a,j)=>`--- ARTICLE ${j+1} ---\nURL: ${a.url}\nPublished: ${a.pubDate}\n\n${a.text}`).join("\n\n");
    const results=await extractWithGroq(input,env.GROQ_API_KEY);
    extracted.push(...results);
    // single article per run — no delay needed
  }
  console.log(`Extracted ${extracted.length} articles`);
  const files={}, articleEntries=[], newEntities=new Set();
  for (let i=0;i<extracted.length;i++) {
    const d=extracted[i], src=withText[i];
    if (!src) continue;
    const filename=articleFilename(d,src.pubDate);
    files[filename]=buildNote(d,src.url,src.pubDate);
    articleEntries.push({d,filename});
    for (const p of (d.people||[])) newEntities.add(`People/${safe(p.name)}|person|${p.name}`);
    for (const o of (d.organizations||[])) newEntities.add(`Orgs/${safe(o)}|organization|${o}`);
    for (const pl of (d.places||[])) newEntities.add(`Places/${safe(pl)}|place|${pl}`);
    for (const t of (d.topics||[])) newEntities.add(`Topics/${safe(t)}|topic|${t}`);
    for (const a of (d.authors||[])) newEntities.add(`Authors/${safe(a)}|author|${a}`);
  }
  files[`Daily/${today}.md`]=buildDailyNote(today,articleEntries);
  for (const entry of newEntities) { const p=entry.split("|"); files[`Entities/${p[0]}.md`]=buildEntityStub(p[2],p[1]); }
  const sha=await pushToGitHub(files,env.GITHUB_TOKEN,env.GITHUB_REPO,env.GITHUB_BRANCH||"main");
  console.log(`Pushed ${Object.keys(files).length} files — commit ${sha.slice(0,7)}`);
}

export default {
  async fetch(request, env) {
    const {pathname,searchParams}=new URL(request.url);
    if (pathname==="/run" && searchParams.get("secret")===env.TRIGGER_SECRET) {
      try { await runPipeline(env); return new Response("Pipeline complete",{status:200}); }
      catch(e) { return new Response(`Error: ${e.message}`,{status:500}); }
    }
    return new Response("NewsLink Worker running.",{status:200});
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPipeline(env));
  }
};
