import { chromium,type Browser,type BrowserContext,type Page } from 'playwright';
import { randomUUID } from 'node:crypto';

type Session = {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
  activeCalls: number;
};

type BrowserManagerOptions = {
  launch?: () => Promise<Browser>;
  now?: () => number;
  maxSessions?: number;
  idleMs?: number;
  reapIntervalMs?: number;
};

function positiveInteger(value: string | undefined,fallback: number) {
  const parsed=Number(value);
  return Number.isInteger(parsed)&&parsed>0?parsed:fallback;
}

export class BrowserManager {
  private readonly sessions=new Map<string,Session>();
  private readonly launchBrowser: () => Promise<Browser>;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private readonly reaper?: ReturnType<typeof setInterval>;
  private browser: Browser|undefined;
  private launchPending: Promise<Browser>|undefined;
  private pendingCreates=0;

  constructor(options: BrowserManagerOptions={}) {
    this.launchBrowser=options.launch??(()=>chromium.launch({
      headless:process.env.NEXUS_BROWSER_HEADLESS!=='false'
    }));
    this.now=options.now??Date.now;
    this.maxSessions=options.maxSessions??positiveInteger(process.env.NEXUS_BROWSER_MAX_SESSIONS,4);
    this.idleMs=options.idleMs??positiveInteger(process.env.NEXUS_BROWSER_IDLE_MS,5*60_000);
    const reapIntervalMs=options.reapIntervalMs??positiveInteger(process.env.NEXUS_BROWSER_REAP_INTERVAL_MS,30_000);
    if(reapIntervalMs>0){
      this.reaper=setInterval(()=>void this.reapIdle(),reapIntervalMs);
      this.reaper.unref();
    }
  }

  private session(id: string) {
    const value=this.sessions.get(id);
    if(!value)throw new Error(`browser session not found: ${id}`);
    return value;
  }

  private async ensureBrowser() {
    if(this.browser?.isConnected())return this.browser;
    if(this.launchPending)return this.launchPending;
    this.launchPending=this.launchBrowser().then((browser)=>{
      this.browser=browser;
      browser.on('disconnected',()=>{
        if(this.browser===browser)this.browser=undefined;
        this.sessions.clear();
      });
      return browser;
    }).finally(()=>{this.launchPending=undefined;});
    return this.launchPending;
  }

  private async withSession<T>(id: string,operation: (session: Session) => Promise<T>) {
    const session=this.session(id);
    session.activeCalls++;
    session.lastUsedAt=this.now();
    try{return await operation(session);}
    finally{
      session.activeCalls--;
      session.lastUsedAt=this.now();
    }
  }

  private async closeSession(id: string) {
    const value=this.sessions.get(id);
    if(!value)return false;
    this.sessions.delete(id);
    await value.context.close().catch(()=>undefined);
    return true;
  }

  private async closeBrowserWhenUnused() {
    if(this.sessions.size||this.pendingCreates||!this.browser)return;
    const browser=this.browser;
    this.browser=undefined;
    await browser.close().catch(()=>undefined);
  }

  private async makeRoom() {
    if(this.sessions.size+this.pendingCreates<this.maxSessions)return;
    const victim=[...this.sessions.entries()]
      .filter(([,session])=>session.activeCalls===0)
      .sort((a,b)=>a[1].lastUsedAt-b[1].lastUsedAt)[0];
    if(!victim)throw new Error(`browser session limit reached (${this.maxSessions})`);
    await this.closeSession(victim[0]);
  }

  async open(input: {sessionId?:string|undefined;url?:string|undefined;headless?:boolean|undefined}) {
    const sessionId=input.sessionId??randomUUID();
    if(this.sessions.has(sessionId))return this.withSession(sessionId,()=>this.describe(sessionId));
    await this.makeRoom();
    this.pendingCreates++;
    let context: BrowserContext|undefined;
    try{
      const browser=await this.ensureBrowser();
      context=await browser.newContext({
        viewport:{
          width:Number(process.env.NEXUS_BROWSER_WIDTH??1440),
          height:Number(process.env.NEXUS_BROWSER_HEIGHT??1000)
        }
      });
      const page=await context.newPage();
      if(input.url)await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:30_000});
      this.sessions.set(sessionId,{context,page,lastUsedAt:this.now(),activeCalls:0});
      return this.describe(sessionId);
    }catch(error){
      await context?.close().catch(()=>undefined);
      throw error;
    }finally{
      this.pendingCreates--;
      await this.closeBrowserWhenUnused();
    }
  }

  async navigate(sessionId:string,url:string){
    return this.withSession(sessionId,async({page})=>{
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:30_000});
      return this.describe(sessionId);
    });
  }

  async click(input:{sessionId:string;selector?:string|undefined;x?:number|undefined;y?:number|undefined}){
    return this.withSession(input.sessionId,async({page})=>{
      if(input.selector)await page.locator(input.selector).first().click({timeout:15_000});
      else if(input.x!==undefined&&input.y!==undefined)await page.mouse.click(input.x,input.y);
      else throw new Error('browser.click requires selector or x/y');
      return this.describe(input.sessionId);
    });
  }

  async type(input:{sessionId:string;selector?:string|undefined;text:string}){
    return this.withSession(input.sessionId,async({page})=>{
      if(input.selector)await page.locator(input.selector).first().fill(input.text);
      else await page.keyboard.type(input.text);
      return this.describe(input.sessionId);
    });
  }

  async extract(input:{sessionId:string;selector?:string|undefined;mode?:'text'|'html'|undefined}){
    return this.withSession(input.sessionId,async({page})=>{
      const locator=page.locator(input.selector??'body').first();
      const content=input.mode==='html'?await locator.innerHTML():await locator.innerText();
      return{...(await this.describe(input.sessionId)),content:content.slice(0,120_000)};
    });
  }

  async screenshot(input:{sessionId:string;fullPage?:boolean}){
    return this.withSession(input.sessionId,async({page})=>{
      const data=await page.screenshot({type:'png',fullPage:input.fullPage??false});
      return{...(await this.describe(input.sessionId)),mimeType:'image/png',dataBase64:data.toString('base64')};
    });
  }

  async close(sessionId:string){
    if(!await this.closeSession(sessionId))throw new Error(`browser session not found: ${sessionId}`);
    await this.closeBrowserWhenUnused();
    return{sessionId,closed:true};
  }

  async reapIdle(){
    const cutoff=this.now()-this.idleMs;
    const expired=[...this.sessions.entries()]
      .filter(([,session])=>session.activeCalls===0&&session.lastUsedAt<=cutoff)
      .map(([id])=>id);
    await Promise.all(expired.map((id)=>this.closeSession(id)));
    await this.closeBrowserWhenUnused();
    return expired;
  }

  async closeAll(){
    if(this.reaper)clearInterval(this.reaper);
    const sessions=[...this.sessions.keys()];
    await Promise.all(sessions.map((id)=>this.closeSession(id)));
    this.pendingCreates=0;
    const browser=this.browser;
    this.browser=undefined;
    await browser?.close().catch(()=>undefined);
  }

  private async describe(sessionId:string){
    const{page}=this.session(sessionId);
    return{sessionId,url:page.url(),title:await page.title()};
  }
}
