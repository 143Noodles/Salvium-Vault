import {afterEach, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const {migrateAuditWireCaches, VERSION, MAINNET_STARTS} = require('../utils/auditWireCacheMigration.cjs');
const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-cache-test-')); roots.push(root);
  const cacheDir=path.join(root,'blocks'),cspDir=path.join(root,'csp');
  await fs.mkdir(cacheDir);await fs.mkdir(cspDir);
  return {root,cacheDir,cspDir,network:'mainnet',schema:8,bundleFiles:[path.join(cacheDir,'txi-bundle-v4.bin'),path.join(cspDir,'csp-bundle-v8.bin')],log:()=>{}};
}
async function chunk(f:any,start:number,raw=true) {
  const stem=`${start}-${start+999}`;
  await fs.writeFile(path.join(f.cacheDir,`blocks-${stem}.txi`),'old-index');
  await fs.writeFile(path.join(f.cspDir,`csp-v8-${stem}.csp`),'old-csp');
  if(raw)await fs.writeFile(path.join(f.cacheDir,`blocks-${stem}.bin`),'canonical-raw');
}
const rebuilt = () => ({txi:Buffer.alloc(16,17),csp:Buffer.alloc(12,23)});
afterEach(async()=>{await Promise.all(roots.splice(0).map(r=>fs.rm(r,{recursive:true,force:true})));});
test('repairs the two consensus Audit windows and keeps raw/unrelated history intact',async()=>{
 const f=await fixture();await chunk(f,154000);await chunk(f,172000);await chunk(f,180000);
 for(const file of f.bundleFiles)await fs.writeFile(file,'stale-bundle');
 const seen:number[]=[];
 const r=await migrateAuditWireCaches({...f,rebuild:async({start,raw}:any)=>{expect(raw.toString()).toBe('canonical-raw');seen.push(start);return rebuilt();}});
 expect(seen).toEqual([154000,172000]);expect(r.repaired).toBe(2);
 expect(await fs.readFile(path.join(f.cacheDir,'blocks-154000-154999.txi'))).toEqual(rebuilt().txi);
 expect(await fs.readFile(path.join(f.cacheDir,'blocks-154000-154999.bin'),'utf8')).toBe('canonical-raw');
 expect(await fs.readFile(path.join(f.cacheDir,'blocks-180000-180999.txi'),'utf8')).toBe('old-index');
 for(const file of f.bundleFiles)await expect(fs.stat(file)).rejects.toMatchObject({code:'ENOENT'});
 expect((await fs.readFile(path.join(f.cacheDir,'.audit-wire-cache-version'),'utf8')).trim()).toBe(VERSION);
 const second=await migrateAuditWireCaches({...f,rebuild:()=>{throw Error('must not repeat');}});expect(second.alreadyCurrent).toBe(true);
});
test('a validation failure in a later chunk leaves every original and marker untouched',async()=>{
 const f=await fixture();await chunk(f,154000);await chunk(f,155000);
 await expect(migrateAuditWireCaches({...f,rebuild:async({start}:any)=>{if(start===155000)throw Error('canonical mismatch');return rebuilt();}})).rejects.toThrow('canonical mismatch');
 expect(await fs.readFile(path.join(f.cacheDir,'blocks-154000-154999.txi'),'utf8')).toBe('old-index');
 await expect(fs.stat(path.join(f.cacheDir,'.audit-wire-cache-version'))).rejects.toMatchObject({code:'ENOENT'});
});
test('quarantines bundle-only stale data rather than marking it repaired',async()=>{
 const f=await fixture();await chunk(f,154000,false);
 const r=await migrateAuditWireCaches({...f,rebuild:()=>{throw Error('no raw data');}});
 expect(r).toEqual({repaired:0,invalidated:1});await expect(fs.stat(path.join(f.cacheDir,'blocks-154000-154999.txi'))).rejects.toMatchObject({code:'ENOENT'});
});
test('prepares auxiliary spent/stake caches before committing any chunk',async()=>{
 const f=await fixture();await chunk(f,154000);const aux=path.join(f.cacheDir,'key-image-cache.json');await fs.writeFile(aux,'old-spends');
 await expect(migrateAuditWireCaches({...f,rebuild:rebuilt,auxiliary:()=>{throw Error('conflicting spend');}})).rejects.toThrow('conflicting spend');
 expect(await fs.readFile(path.join(f.cacheDir,'blocks-154000-154999.txi'),'utf8')).toBe('old-index');
 await migrateAuditWireCaches({...f,rebuild:rebuilt,auxiliary:async()=>[{path:aux,data:Buffer.from('canonical-spends')}]});
 expect(await fs.readFile(aux,'utf8')).toBe('canonical-spends');
});
test('repairs auxiliary-only history even without existing individual scan chunks',async()=>{
 const f=await fixture();const aux=path.join(f.cacheDir,'key-image-cache.json');await fs.writeFile(aux,'old-spends');
 await fs.writeFile(path.join(f.cacheDir,'blocks-154000-154999.bin'),'canonical-raw');let called=0;
 await migrateAuditWireCaches({...f,auxiliaryFiles:[aux],rebuild:()=>{called++;return rebuilt();}});expect(called).toBe(1);
});
test('does not reuse mainnet fork heights for another network',async()=>{
 const f=await fixture();await chunk(f,1000);let called=0;
 await migrateAuditWireCaches({...f,network:'testnet',rebuild:()=>{called++;return rebuilt();}});expect(called).toBe(1);
 expect(MAINNET_STARTS).toHaveLength(16);
});

test('preserves canonical mainnet return heights for both Audit epochs',()=>{
 const {auditReturnOffset}=require('../utils/auditWireCacheMigration.cjs');
 expect(auditReturnOffset('mainnet',154750)).toBe(7201);
 expect(auditReturnOffset('mainnet',161899)).toBe(7201);
 expect(auditReturnOffset('mainnet',172000)).toBe(10081);
 expect(auditReturnOffset('mainnet',179199)).toBe(10081);
 for(const height of [154749,161900,179200])expect(()=>auditReturnOffset('mainnet',height)).toThrow();
});
