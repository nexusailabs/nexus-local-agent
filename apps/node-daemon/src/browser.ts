import { chromium,type Browser,type BrowserContext,type Page } from 'playwright';
import { randomUUID } from 'node:crypto';

type Session={browser:Browser;context:BrowserContext;page:Page};
export class BrowserManager{
  private readonly sessions=new Map<string,Session>();
  private session(id:string){const value=this.sessions.get(id);if(!value)throw new Error(`browser session not found: ${id}`);return value;}
  async open(input:{sessionId?:string;url?:string;headless?:boolean}){const sessionId=input.sessionId??randomUUID();if(this.sessions.has(sessionId))return this.describe(sessionId);const browser=await chromium.launch({headless:input.headless??process.env.NEXUS_BROWSER_HEADLESS!=='false'});const context=await browser.newContext({viewport:{width:Number(process.env.NEXUS_BROWSER_WIDTH??1440),height:Number(process.env.NEXUS_BROWSER_HEIGHT??1000)}});const page=await context.newPage();this.sessions.set(sessionId,{browser,context,page});if(input.url)await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:30_000});return this.describe(sessionId);}
  async navigate(sessionId:string,url:string){const {page}=this.session(sessionId);await page.goto(url,{waitUntil:'domcontentloaded',timeout:30_000});return this.describe(sessionId);}
  async click(input:{sessionId:string;selector?:string;x?:number;y?:number}){const {page}=this.session(input.sessionId);if(input.selector)await page.locator(input.selector).first().click({timeout:15_000});else if(input.x!==undefined&&input.y!==undefined)await page.mouse.click(input.x,input.y);else throw new Error('browser.click requires selector or x/y');return this.describe(input.sessionId);}
  async type(input:{sessionId:string;selector?:string;text:string}){const {page}=this.session(input.sessionId);if(input.selector)await page.locator(input.selector).first().fill(input.text);else await page.keyboard.type(input.text);return this.describe(input.sessionId);}
  async extract(input:{sessionId:string;selector?:string;mode?:'text'|'html'}){const {page}=this.session(input.sessionId);const locator=page.locator(input.selector??'body').first();const content=input.mode==='html'?await locator.innerHTML():await locator.innerText();return{...(await this.describe(input.sessionId)),content:content.slice(0,120_000)};}
  async screenshot(input:{sessionId:string;fullPage?:boolean}){const {page}=this.session(input.sessionId);const data=await page.screenshot({type:'png',fullPage:input.fullPage??false});return{...(await this.describe(input.sessionId)),mimeType:'image/png',dataBase64:data.toString('base64')};}
  async close(sessionId:string){const value=this.session(sessionId);await value.context.close();await value.browser.close();this.sessions.delete(sessionId);return{sessionId,closed:true};}
  async closeAll(){await Promise.allSettled([...this.sessions.keys()].map((id)=>this.close(id)));}
  private async describe(sessionId:string){const {page}=this.session(sessionId);return{sessionId,url:page.url(),title:await page.title()};}
}
