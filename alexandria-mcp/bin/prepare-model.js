#!/usr/bin/env node
'use strict';
// Explicit opt-in download only; never called from a memory tool or discovery.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');
const profile=require('../lib/retrieval/model-profile.json');
async function main(){
 const args=process.argv.slice(2);
 if(args.includes('--help')){console.log('Usage: node alexandria-mcp/bin/prepare-model.js --model-root ABSOLUTE_DIRECTORY\nDownloads pinned multilingual-e5-small q8 files (~136 MB), verifies SHA256 and writes manifest.json. No client/vault config changes.');return;}
 const i=args.indexOf('--model-root');const root=args[i+1];if(i<0||!root||!path.isAbsolute(root))throw Error('Provide absolute --model-root');
 const dir=path.resolve(root,profile.model);fs.mkdirSync(dir,{recursive:true});
 for(const [name,expected] of Object.entries(profile.files)){
  const target=path.resolve(dir,name);if(!target.startsWith(dir+path.sep))throw Error('Unsafe model profile');fs.mkdirSync(path.dirname(target),{recursive:true});
  if(fs.existsSync(target)&&fs.statSync(target).size===expected.bytes&&crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')===expected.sha256)continue;
  const partial=target+'.part';const hash=crypto.createHash('sha256');let bytes=0;
  try{
   const response=await fetch(`https://huggingface.co/${profile.model}/resolve/${profile.revision}/${name}`,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error('Model download failed');
   await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);done(null,chunk);}}),fs.createWriteStream(partial));
   if(bytes!==expected.bytes||hash.digest('hex')!==expected.sha256)throw Error('Model checksum mismatch');fs.renameSync(partial,target);
  }catch(error){try{fs.unlinkSync(partial);}catch{}throw error;}
 }
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(profile,null,2)+'\n');console.log(`Verified offline model: ${dir}`);
}
main().catch(()=>{process.stderr.write('Model preparation failed. Verify model root, network and checksums.\n');process.exitCode=1;});
