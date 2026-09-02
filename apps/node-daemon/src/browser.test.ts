import { describe,expect,it,vi } from 'vitest';
import type { Browser,BrowserContext,Page } from 'playwright';
import { BrowserManager } from './browser.js';

function fakeRuntime(){
  const contexts: Array<{context:BrowserContext;close:ReturnType<typeof vi.fn>}>=[];
  const browserClose=vi.fn(async()=>undefined);
  const browser={
    isConnected:()=>true,
    on:vi.fn(),
    close:browserClose,
    newContext:vi.fn(async()=>{
      const page={
        url:()=> 'about:blank',
        title:vi.fn(async()=>''),
        goto:vi.fn(async()=>null)
      } as unknown as Page;
      const close=vi.fn(async()=>undefined);
      const context={newPage:vi.fn(async()=>page),close} as unknown as BrowserContext;
      contexts.push({context,close});
      return context;
    })
  } as unknown as Browser;
  const launch=vi.fn(async()=>browser);
  return{browserClose,contexts,launch};
}

describe('BrowserManager',()=>{
  it('shares one browser and closes it after the final session',async()=>{
    const runtime=fakeRuntime();
    const manager=new BrowserManager({launch:runtime.launch,reapIntervalMs:0});
    await manager.open({sessionId:'one'});
    await manager.open({sessionId:'two'});
    expect(runtime.launch).toHaveBeenCalledTimes(1);
    expect(runtime.contexts).toHaveLength(2);
    await manager.close('one');
    expect(runtime.browserClose).not.toHaveBeenCalled();
    await manager.close('two');
    expect(runtime.browserClose).toHaveBeenCalledTimes(1);
  });

  it('reaps idle sessions and their shared browser',async()=>{
    const runtime=fakeRuntime();
    let now=1_000;
    const manager=new BrowserManager({launch:runtime.launch,now:()=>now,idleMs:100,reapIntervalMs:0});
    await manager.open({sessionId:'idle'});
    now=1_101;
    expect(await manager.reapIdle()).toEqual(['idle']);
    expect(runtime.contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(runtime.browserClose).toHaveBeenCalledTimes(1);
  });

  it('evicts the least-recent inactive session at the configured limit',async()=>{
    const runtime=fakeRuntime();
    let now=1;
    const manager=new BrowserManager({launch:runtime.launch,now:()=>now,maxSessions:2,reapIntervalMs:0});
    await manager.open({sessionId:'oldest'});
    now=2;
    await manager.open({sessionId:'newer'});
    now=3;
    await manager.open({sessionId:'replacement'});
    expect(runtime.contexts[0]?.close).toHaveBeenCalledTimes(1);
    await expect(manager.close('oldest')).rejects.toThrow('browser session not found');
    await manager.closeAll();
  });
});
