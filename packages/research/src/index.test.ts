import { describe,expect,it } from 'vitest';
import { SearchBroker,type SearchProvider } from './index.js';
const provider=(name:string,rows:Array<{title:string;url:string;snippet:string;score:number}>):SearchProvider=>({name,async search(){return rows.map((row)=>({...row,provider:name}));}});
describe('SearchBroker',()=>{it('merges and deduplicates providers',async()=>{const broker=new SearchBroker([provider('a',[{title:'A',url:'https://example.com/x?utm_source=a',snippet:'a',score:10}]),provider('b',[{title:'B',url:'https://example.com/x',snippet:'b',score:20},{title:'C',url:'https://example.com/y',snippet:'c',score:15}])]);const result=await broker.search('q',10);expect(result).toHaveLength(2);expect(result[0]?.title).toBe('B');});});
