const fs=require('fs'),path=require('path'),assert=require('assert/strict'),os=require('os');
(async()=>{
 const runtime=path.resolve(process.argv[2]),dir=path.resolve(process.argv[3] || __dirname);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'salvium-audit-wire-'));
 try {
  const glue=path.join(tmp,'runtime.cjs');fs.copyFileSync(path.join(runtime,'SalviumWallet.js'),glue);
  const m=await require(glue)({locateFile:f=>path.join(runtime,f),print(){},printErr(){}});
  const original=fs.readFileSync(path.join(dir,'warning-tx.spr7'));
  const daemon=JSON.parse(fs.readFileSync(path.join(dir,'warning-tx-full.json'))).txs[0];
  const full=Buffer.from(daemon.as_hex,'hex'),decoded=JSON.parse(daemon.as_json);
  let off=8+4+4+8+32+32;off+=2+original.readUInt16LE(off)*4;off+=2+original.readUInt16LE(off)*4;
  const blobStart=off+4,base=original.subarray(blobStart);
  assert.equal(original.readUInt32LE(off),base.length);
  const record=(blob)=>{const b=Buffer.concat([original.subarray(0,blobStart),blob]);b.writeUInt32LE(blob.length,off);return b};
  const cases=[['canonical pruned Audit',original,true],['canonical full Audit',record(full),true]];
  for(const len of [0,1,100,base.length-1,base.length-8,base.length-32])cases.push(['truncated base '+len,record(base.subarray(0,len)),false]);
  const varint=(value)=>{let n=BigInt(value),out=[];do{let b=Number(n&127n);n>>=7n;out.push(b|(n?128:0));}while(n);return Buffer.from(out)};
  const markerOffsets=new Map();
  for(const [index,input] of decoded.rct_signatures.salvium_data.input_verification_data.entries()){
   if(!input.origin_tx_type)continue;
   const fixed=Buffer.alloc(8);fixed.writeBigUInt64LE(BigInt(input.i_stake));
   const marker=Buffer.concat([Buffer.from(input.aR,'hex'),varint(input.amount),varint(input.i),varint(input.origin_tx_type),Buffer.from(input.aR_stake,'hex'),fixed]);
   const key=marker.toString('hex'),found=base.indexOf(marker,markerOffsets.get(key)||0);
   assert(found>=0,'daemon-decoded input must exactly match its canonical binary fields');
   const at=found+marker.length-8;markerOffsets.set(key,found+marker.length);
   assert.equal(base.readBigUInt64LE(at),BigInt(input.i_stake));
   for(const byte of [0,4,7]){const b=Buffer.from(base);b[at+byte]^=1;cases.push(['tampered fixed index '+index+'/'+byte,record(b),false]);}
   const shortened=Buffer.concat([base.subarray(0,at+4),base.subarray(at+8)]);
   cases.push(['invalid four-byte index '+index,record(shortened),false]);
  }
  for(const [marker,offset] of markerOffsets)assert.equal(base.indexOf(Buffer.from(marker,'hex'),offset),-1,'all repeated stake references exercised');
  for(const at of [24,56]){const b=Buffer.from(original);b[at]^=1;cases.push(['tampered '+(at===24?'transaction':'prunable')+' hash',b,false]);}
  for(const [name,bytes,valid]of cases){
   console.log("Checking "+name);
   const w=new m.WasmWallet();assert(w.create_random('','English'));
   const ptr=m.allocate_binary_buffer(bytes.length);m.HEAPU8.set(bytes,ptr);
   const r=JSON.parse(w.cache_runtime_full_txs_from_sparse(ptr,bytes.length,true));m.free_binary_buffer(ptr);
   assert.equal(r.stored,valid?1:0,name);assert.equal(r.rejected_count,valid?0:1,name);
   if(valid)assert.deepEqual(r.stored_hashes,[daemon.tx_hash],name);
   assert.equal(r.runtime_full_tx_count,valid?1:0,name);w.delete();
  }
  console.log(JSON.stringify({passed:cases.length,canonicalForms:2,rejectedMutations:cases.length-2,hash:daemon.tx_hash}));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
