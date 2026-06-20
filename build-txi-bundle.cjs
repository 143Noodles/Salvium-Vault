// Standalone: pack CACHE_DIR/blocks-<start>-<end>.txi (v4) into txi-bundle-v4.bin.
// Format MUST match extractTxiBundleToChunks in server.cjs:
//   header(20): magic u32, version u32, chunkCount u32, firstHeight u32, lastHeight u32
//   index(chunkCount*24): start u32, end u32, dataOffset u64, dataLength u64
//   data: concatenated .txi bytes
const fs=require('fs'); const fsp=require('fs/promises'); const path=require('path');
const CACHE_DIR=process.argv[2]; if(!CACHE_DIR){console.error('usage: node build-txi-bundle.cjs <cacheDir>');process.exit(1);}
const OUT=process.argv[3]||path.join(CACHE_DIR,'txi-bundle-v4.bin');
const MAGIC=0x42495854, VERSION=1; const TXI_V4=Buffer.from('TXI\x04');
(async()=>{
  const files=(await fsp.readdir(CACHE_DIR)).filter(f=>/^blocks-\d+-\d+\.txi$/.test(f));
  let chunks=[];
  for(const f of files){
    const m=f.match(/^blocks-(\d+)-(\d+)\.txi$/); const fp=path.join(CACHE_DIR,f);
    const st=await fsp.stat(fp); if(st.size<4)continue;
    const fd=await fsp.open(fp,'r'); const hb=Buffer.alloc(4);
    try{await fd.read(hb,0,4,0)}finally{await fd.close()}
    if(!hb.equals(TXI_V4)){console.error('skip non-v4: '+f);continue;}
    chunks.push({start:+m[1],end:+m[2],size:st.size,file:fp});
  }
  chunks.sort((a,b)=>a.start-b.start);
  if(!chunks.length){console.error('no v4 txi files found');process.exit(1);}
  let off=0; for(const c of chunks){c.offset=off; off+=c.size;}
  const headerSize=20+chunks.length*24; const header=Buffer.alloc(headerSize); let p=0;
  header.writeUInt32LE(MAGIC,p);p+=4; header.writeUInt32LE(VERSION,p);p+=4; header.writeUInt32LE(chunks.length,p);p+=4;
  header.writeUInt32LE(chunks[0].start,p);p+=4; header.writeUInt32LE(chunks[chunks.length-1].end,p);p+=4;
  for(const c of chunks){header.writeUInt32LE(c.start,p);p+=4; header.writeUInt32LE(c.end,p);p+=4; header.writeBigUInt64LE(BigInt(c.offset),p);p+=8; header.writeBigUInt64LE(BigInt(c.size),p);p+=8;}
  const crypto=require('crypto'); const hash=crypto.createHash('sha256'); hash.update(header);
  const tmp=OUT+'.part'; const ws=fs.createWriteStream(tmp);
  await new Promise((res,rej)=>ws.write(header,e=>e?rej(e):res()));
  for(const c of chunks){ const buf=await fsp.readFile(c.file); hash.update(buf); await new Promise((res,rej)=>ws.write(buf,e=>e?rej(e):res())); }
  await new Promise(res=>ws.end(res));
  await fsp.rename(tmp,OUT);
  const sha=hash.digest('hex'); await fsp.writeFile(OUT+'.sha256', sha);
  console.log('BUILT '+OUT+': '+chunks.length+' chunks, '+((headerSize+off)/1e9).toFixed(2)+'GB ('+chunks[0].start+'-'+chunks[chunks.length-1].end+') sha256='+sha.slice(0,12));
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
