import { convert } from 'html-to-text';
import type { NodeSpec } from '@nexus/protocol';
import { LocalModelClient } from '@nexus/provider';
import { routeInference } from '@nexus/router';

export type SearchResult = { title: string; url: string; snippet: string; provider: string; score: number };
export interface SearchProvider { name: string; search(query: string, limit: number): Promise<SearchResult[]>; }
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export class SearxngProvider implements SearchProvider {
  name = 'searxng'; constructor(private readonly baseUrl: string) {}
  async search(query: string, limit: number) {
    const url = new URL('/search', this.baseUrl); url.searchParams.set('q', query); url.searchParams.set('format', 'json');
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`SearXNG ${response.status}`);
    const body = asObject(await response.json()); return asArray(body.results).slice(0, limit).map((item, index) => {
      const row = asObject(item); return { title:text(row.title), url:text(row.url), snippet:text(row.content), provider:this.name, score:100-index };
    }).filter((row) => row.url);
  }
}
export class BraveProvider implements SearchProvider {
  name = 'brave'; constructor(private readonly apiKey: string) {}
  async search(query: string, limit: number) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search'); url.searchParams.set('q', query); url.searchParams.set('count', String(Math.min(limit,20)));
    const response = await fetch(url, { headers:{ 'X-Subscription-Token':this.apiKey, Accept:'application/json' }, signal:AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Brave ${response.status}`); const body = asObject(await response.json()); const web = asObject(body.web);
    return asArray(web.results).slice(0,limit).map((item,index) => { const row=asObject(item); return {title:text(row.title),url:text(row.url),snippet:text(row.description),provider:this.name,score:100-index}; }).filter((row)=>row.url);
  }
}
export class TavilyProvider implements SearchProvider {
  name='tavily'; constructor(private readonly apiKey:string) {}
  async search(query:string, limit:number) {
    const response=await fetch('https://api.tavily.com/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api_key:this.apiKey,query,max_results:limit,search_depth:'advanced'}),signal:AbortSignal.timeout(20_000)});
    if(!response.ok) throw new Error(`Tavily ${response.status}`); const body=asObject(await response.json());
    return asArray(body.results).slice(0,limit).map((item,index)=>{const row=asObject(item);return{title:text(row.title),url:text(row.url),snippet:text(row.content),provider:this.name,score:typeof row.score==='number'?row.score*100:100-index};}).filter((row)=>row.url);
  }
}
export class ExaProvider implements SearchProvider {
  name='exa'; constructor(private readonly apiKey:string) {}
  async search(query:string, limit:number) {
    const response=await fetch('https://api.exa.ai/search',{method:'POST',headers:{'content-type':'application/json','x-api-key':this.apiKey},body:JSON.stringify({query,numResults:limit,type:'auto'}),signal:AbortSignal.timeout(20_000)});
    if(!response.ok) throw new Error(`Exa ${response.status}`); const body=asObject(await response.json());
    return asArray(body.results).slice(0,limit).map((item,index)=>{const row=asObject(item);return{title:text(row.title),url:text(row.url),snippet:text(row.text),provider:this.name,score:typeof row.score==='number'?row.score*100:100-index};}).filter((row)=>row.url);
  }
}

function normalizeUrl(value:string){ try { const url=new URL(value); url.hash=''; ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach((key)=>url.searchParams.delete(key)); return url.toString(); } catch { return value; } }
export class SearchBroker {
  constructor(readonly providers: SearchProvider[]) {}
  async search(query:string, limit=10):Promise<SearchResult[]> {
    if(!this.providers.length) throw new Error('No web search provider configured. Set NEXUS_SEARXNG_URL, BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or EXA_API_KEY.');
    const settled=await Promise.allSettled(this.providers.map((provider)=>provider.search(query,limit)));
    const dedupe=new Map<string,SearchResult>();
    for(const result of settled) if(result.status==='fulfilled') for(const item of result.value){ const key=normalizeUrl(item.url); const previous=dedupe.get(key); if(!previous||item.score>previous.score) dedupe.set(key,{...item,url:key}); }
    return [...dedupe.values()].sort((a,b)=>b.score-a.score).slice(0,limit);
  }
}
export function createSearchBrokerFromEnv(env:NodeJS.ProcessEnv=process.env):SearchBroker {
  const providers:SearchProvider[]=[]; if(env.NEXUS_SEARXNG_URL) providers.push(new SearxngProvider(env.NEXUS_SEARXNG_URL));
  if(env.BRAVE_SEARCH_API_KEY) providers.push(new BraveProvider(env.BRAVE_SEARCH_API_KEY)); if(env.TAVILY_API_KEY) providers.push(new TavilyProvider(env.TAVILY_API_KEY)); if(env.EXA_API_KEY) providers.push(new ExaProvider(env.EXA_API_KEY));
  return new SearchBroker(providers);
}
export type FetchedDocument={url:string;title:string;contentType:string;text:string};
export async function fetchDocument(url:string,maxChars=60_000):Promise<FetchedDocument>{
  const parsed=new URL(url); if(!['http:','https:'].includes(parsed.protocol)) throw new Error('web.fetch only supports http/https');
  const response=await fetch(parsed,{redirect:'follow',headers:{'user-agent':'NexusLocalAgent/0.2'},signal:AbortSignal.timeout(20_000)}); if(!response.ok) throw new Error(`fetch ${response.status} ${url}`);
  const contentType=response.headers.get('content-type')??''; const raw=(await response.text()).slice(0,2_000_000);
  const extracted=contentType.includes('html')?convert(raw,{wordwrap:false,selectors:[{selector:'script',format:'skip'},{selector:'style',format:'skip'},{selector:'nav',format:'skip'}]}):raw;
  const title=contentType.includes('html')?(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??parsed.hostname).replace(/<[^>]+>/g,' ').trim():parsed.pathname.split('/').pop()||parsed.hostname;
  return {url:response.url,title,contentType,text:extracted.replace(/\n{3,}/g,'\n\n').slice(0,maxChars)};
}

const extractJson=(value:string):unknown=>{const fenced=value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];const raw=fenced??value.slice(value.indexOf('{'),value.lastIndexOf('}')+1);return JSON.parse(raw);};
export type ResearchSource={id:string;title:string;url:string;snippet:string;provider:string};
export type ResearchReport={query:string;queries:string[];sources:ResearchSource[];report:string};
export class DeepResearchService {
  constructor(private readonly nodes:()=>NodeSpec[],private readonly search:SearchBroker){}
  private client(){const nodes=this.nodes();const route=routeInference(nodes,'research');const node=nodes.find((n)=>n.id===route.nodeId);const model=node?.models.find((m)=>m.id===route.modelId);if(!model)throw new Error('research inference route disappeared');return new LocalModelClient(model);}
  async run(query:string,maxRounds=2,maxSources=12):Promise<ResearchReport>{
    const planner=this.client(); const planText=await planner.complete({system:'Generate diverse web research queries. Return only JSON {"queries":[string,...]} with 3-6 queries.',messages:[{role:'user',content:query}],maxTokens:2048,reasoningEffort:'medium'});
    const plan=asObject(extractJson(planText)); let queries=[query,...asArray(plan.queries).map(text).filter(Boolean)].slice(0,7); const found=new Map<string,SearchResult>();
    for(let round=0;round<Math.max(1,maxRounds);round++){
      const batches=await Promise.all(queries.map((q)=>this.search.search(q,Math.max(4,Math.ceil(maxSources/queries.length))))); for(const item of batches.flat()) if(!found.has(item.url)) found.set(item.url,item);
      if(round+1>=maxRounds)break; const compact=[...found.values()].slice(0,maxSources).map((s)=>`${s.title}: ${s.snippet}`).join('\n');
      const gap=await planner.complete({system:'Find material research gaps. Return only JSON {"queries":[string,...]}; use [] when evidence is sufficient.',messages:[{role:'user',content:`Question: ${query}\nEvidence summaries:\n${compact}`}],maxTokens:1536,reasoningEffort:'low'});
      queries=asArray(asObject(extractJson(gap)).queries).map(text).filter(Boolean).slice(0,4); if(!queries.length)break;
    }
    const ranked=[...found.values()].sort((a,b)=>b.score-a.score).slice(0,maxSources); const docs=await Promise.allSettled(ranked.map((source)=>fetchDocument(source.url,18_000)));
    const sources:ResearchSource[]=ranked.map((source,index)=>({id:`S${index+1}`,title:source.title,url:source.url,snippet:source.snippet,provider:source.provider}));
    const evidence=ranked.map((source,index)=>{const doc=docs[index];const body=doc?.status==='fulfilled'?doc.value.text:source.snippet;return `[S${index+1}] ${source.title}\nURL: ${source.url}\n${body}`;}).join('\n\n');
    const report=await planner.complete({system:'Write a rigorous research report grounded only in supplied sources. Cite factual claims inline with [S#]. Explicitly identify disagreements or missing evidence.',messages:[{role:'user',content:`Question: ${query}\n\nSources:\n${evidence}`}],maxTokens:12_000,reasoningEffort:'high'});
    return {query,queries:[query,...ranked.slice(0,3).map((s)=>s.title)],sources,report};
  }
}
