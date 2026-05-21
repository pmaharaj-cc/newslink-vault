/**
 * NewsLink Worker — hourly cron
 * Criminal record tracking, role inference, author exclusion from people[].
 * v2: HTML-aware extraction — targets asset-content div, itemprop="author" byline.
 */
const SITEMAP="https://trinidadexpress.com/tncms/sitemap/news.xml";
const GROQ_URL="https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL="llama-3.3-70b-versatile";
const GH_REPO="pmaharaj-cc/newslink-vault";
const GH_BRANCH="main";
const TT_OFFSET_MS=-4*60*60*1000;
const MAX_FETCH=15;
const MAX_PROCESS=3;
const TEXT_LIMIT=1600;

const SYSTEM_PROMPT=`Extract Trinidad news. Return JSON array only. One object per article. Fields:
title,authors([str]),date_reported(YYYY-MM-DD),date_effective(YYYY-MM-DD|null),
people([{name,role,legal_status}]),organizations([str]),places([str]),
topics([economy|crime|government|health|environment|energy|foreign-affairs|education|judiciary|parliament|corruption|housing|infrastructure|social|culture|disaster]),
state_changes([{entity,change,from,to,date_reported,date_effective}]),
relationships([{from,relation,to}]),quotes([{speaker,text}] max 2 unnamed=Anonymous),
sentiment([{author,target,lean(positive|negative|neutral),basis}]),sports_crossover(bool).
Rules:
- If a "Byline:" line appears in the input, that is the article author. Set authors[] to exactly that name.
- people = named individuals who are SUBJECTS of the article. Never include article authors/journalists.
- role = infer from context if not stated (presiding in court -> Magistrate or Judge; addressing Parliament -> MP or Senator; leading police operation -> Police Officer; prosecuting -> Prosecutor; defending -> Defence Attorney). Never leave role null if context implies one.
- legal_status per person: accused|charged|convicted|acquitted|wanted or null if not explicitly stated.
- organizations = real named bodies only. state_changes entity = real named person or organization only, never generic phrases like "multiple accused persons".
- Empty=[] Unknown=null. No text outside JSON.`;

function todayTT(){return new Date(Date.now()+TT_OFFSET_MS).toISOString().slice(0,10);}
function xmlTag(block,tag){const m=block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));return m?m[1].trim().replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"'):"";}
function safe(name){return String(name).replace(/[<>:"/\\|?*]/g,"").trim();}
function wl(name){return`[[${safe(name)}]]`;}

async function safeJSON(res,label){
  const text=await res.text();
  if(!res.ok)throw new Error(`${label} HTTP ${res.status}: ${text.slice(0,300)}`);
  try{return JSON.parse(text);}catch(e){throw new Error(`${label} bad JSON: ${text.slice(0,200)}`);}
}

const ghH=(token)=>({"Authorization":`token ${token}`,"Content-Type":"application/json","Accept":"application/vnd.github.v3+json","User-Agent":"newslink-worker"});

async function fetchTodayURLs(){
  const res=await fetch(SITEMAP,{headers:{"User-Agent":"Mozilla/5.0"}});
  const xml=await res.text();
  const today=todayTT();
  const seen=new Set();const articles=[];
  for(const block of(xml.match(/<url>[\s\S]*?<\/url>/g)||[])){
    const url=xmlTag(block,"loc");const pub=xmlTag(block,"news:publication_date");
    if(!url||seen.has(url))continue;
    if(!pub.startsWith(today))continue;
    if(url.includes("/sports/"))continue;
    seen.add(url);articles.push({url,pubDate:pub});
  }
  return articles.slice(0,MAX_FETCH);
}

async function fetchArticleText(url){
  try{
    const res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});
    if(!res.ok)return null;
    const html=await res.text();

    // Extract author from schema.org itemprop="author" (reliable on Trinidad Express)
    const authorM=html.match(/itemprop="author"[^>]*>\s*([^\n<]{2,80})/);
    const htmlAuthor=authorM?authorM[1].trim():null;

    // Target asset-content div for clean article body (excludes nav/ads/related stories)
    const contentM=html.match(/<div[^>]*class="[^"]*asset-content[^"]*"[^>]*>([\s\S]+)/);
    const bodyHtml=contentM?contentM[1]:html;

    const ps=(bodyHtml.match(/<p[^>]*>[\s\S]*?<\/p>/g)||[])
      .map(p=>p.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim())
      .filter(p=>p.length>60);
    const seen=new Set();
    const unique=ps.filter(p=>{const k=p.slice(0,80);return seen.has(k)?false:!!seen.add(k);});
    const body=unique.join("\n\n").slice(0,TEXT_LIMIT);

    return body?{body,htmlAuthor}:null;
  }catch(e){return null;}
}

async function extractWithGroq(text,apiKey){
  const res=await fetch(GROQ_URL,{method:"POST",headers:{"Authorization":`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model:GROQ_MODEL,temperature:0,max_tokens:1024,messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:text}]})});
  const data=await safeJSON(res,"Groq");
  const raw=data.choices?.[0]?.message?.content||"[]";
  const cleaned=raw.replace(/^```json\s*/,"").replace(/\s*```$/,"").trim();
  try{const p=JSON.parse(cleaned);return Array.isArray(p)?p:[p];}
  catch(e){throw new Error(`Groq JSON: ${cleaned.slice(0,200)}`);}
}

function buildNote(d,url,pubDate){
  const date=d.date_reported||pubDate.slice(0,10),dateEff=d.date_effective,authors=d.authors||[];
  const authorSet=new Set(authors.map(a=>a.toLowerCase().trim()));
  const people=(d.people||[]).filter(p=>!authorSet.has(p.name.toLowerCase().trim()));
  const orgs=d.organizations||[],places=d.places||[],topics=d.topics||[];

  const lines=["---",`title: "${(d.title||"Untitled").replace(/"/g,"'")}"`,`date_reported: ${date}`,`date_effective: ${dateEff||"null"}`,`source: trinidadexpress.com`,`url: ${url}`,`authors: [${authors.join(", ")}]`,`tags: [${topics.join(", ")}]`,`sports_crossover: ${d.sports_crossover||false}`,"---","",`# ${d.title||"Untitled"}`,`> ${date} · trinidadexpress.com · [link](${url})`,""];
  if(authors.length)lines.push(`**By:** ${authors.map(a=>`[[Authors/${safe(a)}|${a}]]`).join(" · ")}`,"");
  if(dateEff&&dateEff!==date)lines.push(`> ⚠️ **Effective:** ${dateEff} (reported ${date})`,"");
  if(people.length){
    lines.push("## People");
    lines.push(people.map(p=>{
      let s=`[[People/${safe(p.name)}|${p.name}]]`;
      if(p.role)s+=` _(${p.role})_`;
      if(p.legal_status)s+=` ⚠️ _${p.legal_status}_`;
      return s;
    }).join(" · "));
    lines.push("");
  }
  if(orgs.length)lines.push("## Organizations",orgs.map(o=>`[[Orgs/${safe(o)}|${o}]]`).join(" · "),"");
  if(places.length)lines.push("## Places",places.map(p=>`[[Places/${safe(p)}|${p}]]`).join(" · "),"");
  if(topics.length)lines.push("## Topics",topics.map(t=>`[[Topics/${safe(t)}|${t}]]`).join(" · "),"");
  const sc=d.state_changes||[];
  if(sc.length){lines.push("## State Changes","");for(const s of sc){const eff=s.date_effective&&s.date_effective!==s.date_reported?` _(effective ${s.date_effective})_`:"";lines.push(`- ${wl(s.entity)}: **${s.from||"?"}** → **${s.to}** _${s.change}_${eff}`);}lines.push("");}
  const rels=d.relationships||[];
  if(rels.length){lines.push("## Relationships","");for(const r of rels)lines.push(`- ${wl(r.from)} **${r.relation}** ${wl(r.to)}`);lines.push("");}
  const quotes=d.quotes||[];
  if(quotes.length){lines.push("## Key Quotes","");for(const q of quotes){lines.push(`> "${q.text}"`,`> — ${wl(q.speaker)}`,"");}}
  const sentiment=d.sentiment||[];
  if(sentiment.length){lines.push("---","## Sentiment","");const icons={positive:"🟢",negative:"🔴",neutral:"⚪"};for(const s of sentiment)lines.push(`- ${wl(s.author)} → ${wl(s.target)}: ${icons[s.lean]||"⚪"} **${s.lean}** — _${s.basis}_`);lines.push("");}
  return lines.join("\n");
}

function buildCriminalStub(name,data){
  const statuses=[...new Set(data.statuses.map(s=>s.status))];
  const roles=[...new Set(data.roles)].filter(Boolean);
  const lines=[
    "---",`type: person`,`name: "${safe(name)}"`,
    `legal_statuses: [${statuses.join(", ")}]`,
    `tags: [criminal-record]`,"---","",
    `# ${name}`,""
  ];
  if(roles.length)lines.push(`**Known roles:** ${roles.join(", ")}`,"");
  lines.push(`**Legal status:** ${statuses.join(", ")}`,"");
  lines.push("## Case History","");
  for(const s of data.statuses){
    lines.push(`- **${s.status}** — [[${s.article.replace(".md","")}|${s.title||"Article"}]] _(${s.date})_`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildDailyNote(date,entries){
  return`# ${date}\n\n## Articles\n\n`+entries.map(({d,filename})=>`- [[${filename.replace(".md","")}|${d.title||"Untitled"}]]`).join("\n")+"\n";
}

function articleFilename(d,pubDate){
  const date=d.date_reported||pubDate.slice(0,10);
  const slug=(d.title||"untitled").replace(/[^\w\s-]/g,"").trim().slice(0,55).replace(/\s+/g,"-");
  return`Articles/${date}_${slug}.md`;
}

async function pushToGitHub(files,token){
  const base=`https://api.github.com/repos/${GH_REPO}`;
  const h=ghH(token);
  const refData=await safeJSON(await fetch(`${base}/git/refs/heads/${GH_BRANCH}`,{headers:h}),"getRef");
  const headSHA=refData.object?.sha;
  if(!headSHA)throw new Error("No HEAD SHA");
  const commitData=await safeJSON(await fetch(`${base}/git/commits/${headSHA}`,{headers:h}),"getCommit");
  const treeSHA=commitData.tree?.sha;
  const treeItems=[];
  for(const[path,content]of Object.entries(files)){
    const blob=await safeJSON(await fetch(`${base}/git/blobs`,{method:"POST",headers:h,body:JSON.stringify({content,encoding:"utf-8"})}),`blob:${path}`);
    treeItems.push({path,mode:"100644",type:"blob",sha:blob.sha});
  }
  const newTree=await safeJSON(await fetch(`${base}/git/trees`,{method:"POST",headers:h,body:JSON.stringify({base_tree:treeSHA,tree:treeItems})}),"createTree");
  const today=todayTT();
  const newCommit=await safeJSON(await fetch(`${base}/git/commits`,{method:"POST",headers:h,body:JSON.stringify({message:`news: ${today} — ${Object.keys(files).filter(f=>f.startsWith("Articles/")).length} articles`,tree:newTree.sha,parents:[headSHA]})}),"createCommit");
  await safeJSON(await fetch(`${base}/git/refs/heads/${GH_BRANCH}`,{method:"PATCH",headers:h,body:JSON.stringify({sha:newCommit.sha})}),"updateRef");
  return newCommit.sha;
}

async function runPipeline(env){
  const today=todayTT();
  console.log(`[${today}] started`);
  const base=`https://api.github.com/repos/${GH_REPO}`;
  const h=ghH(env.GITHUB_TOKEN);

  const procRes=await fetch(`${base}/contents/data/processed.json`,{headers:h});
  const procText=procRes.ok?atob((await procRes.json()).content.replace(/\n/g,"")):"[]";
  const processed=new Set(JSON.parse(procText));

  let entities={People:{}};
  const entRes=await fetch(`${base}/contents/data/entities.json`,{headers:h});
  if(entRes.ok){
    try{const ed=await entRes.json();entities=JSON.parse(atob(ed.content.replace(/\n/g,"")));}catch(e){}
    if(!entities.People)entities.People={};
  }

  const urlItems=await fetchTodayURLs();
  const unprocessed=urlItems.filter(a=>!processed.has(a.url));
  console.log(`${unprocessed.length} unprocessed of ${urlItems.length}`);
  if(!unprocessed.length)return;

  const extracted=[];
  for(let i=0;i<Math.min(unprocessed.length,MAX_PROCESS);i++){
    const a=unprocessed[i];
    const fetched=await fetchArticleText(a.url);
    if(!fetched){processed.add(a.url);continue;}
    try{
      const authorHint=fetched.htmlAuthor?`Byline: ${fetched.htmlAuthor}\n`:"";
      const prompt=`URL: ${a.url}\nPublished: ${a.pubDate}\n${authorHint}\n${fetched.body}`;
      const r=await extractWithGroq(prompt,env.GROQ_API_KEY);
      if(r[0])extracted.push({result:r[0],src:a});
      processed.add(a.url);
    }catch(e){console.log(`failed: ${e.message}`);}
    if(i+1<Math.min(unprocessed.length,MAX_PROCESS))await new Promise(r=>setTimeout(r,2000));
  }
  if(!extracted.length)return;

  const files={};const entries=[];
  for(const{result:d,src}of extracted){
    const fn=articleFilename(d,src.pubDate);
    const date=d.date_reported||src.pubDate.slice(0,10);
    const authors=d.authors||[];
    const authorSet=new Set(authors.map(a=>a.toLowerCase().trim()));
    files[fn]=buildNote(d,src.url,src.pubDate);
    entries.push({d,filename:fn});

    for(const p of(d.people||[])){
      if(!p.name||authorSet.has(p.name.toLowerCase().trim()))continue;
      if(!entities.People[p.name])entities.People[p.name]={roles:[],statuses:[],articles:[]};
      const ep=entities.People[p.name];
      if(p.role&&!ep.roles.includes(p.role))ep.roles.push(p.role);
      if(!ep.articles.includes(fn))ep.articles.push(fn);
      if(p.legal_status){
        const dup=ep.statuses.some(s=>s.article===fn&&s.status===p.legal_status);
        if(!dup)ep.statuses.push({status:p.legal_status,article:fn,title:d.title||"Untitled",date});
      }
    }
  }

  files[`Daily/${today}.md`]=buildDailyNote(today,entries);
  files["data/processed.json"]=JSON.stringify([...processed],null,2);
  files["data/entities.json"]=JSON.stringify(entities,null,2);

  for(const[name,data]of Object.entries(entities.People)){
    if(data.statuses&&data.statuses.length>0){
      files[`Entities/People/${safe(name)}.md`]=buildCriminalStub(name,data);
    }
  }

  const sha=await pushToGitHub(files,env.GITHUB_TOKEN);
  console.log(`pushed ${extracted.length} articles — ${sha.slice(0,7)}`);
}

export default{
  async fetch(request,env){
    const{pathname,searchParams}=new URL(request.url);
    if(pathname==="/run"&&searchParams.get("secret")===env.TRIGGER_SECRET){
      try{await runPipeline(env);return new Response("Pipeline complete",{status:200});}
      catch(e){return new Response(`Error: ${e.message}`,{status:500});}
    }
    return new Response("NewsLink running.",{status:200});
  },
  async scheduled(event,env,ctx){ctx.waitUntil(runPipeline(env));}
};
