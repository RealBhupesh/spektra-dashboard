import {spawn} from 'node:child_process';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start'],{detached:true,stdio:['ignore','pipe','pipe']});server.stdout.on('data',d=>process.stdout.write(d));server.stderr.on('data',d=>process.stderr.write(d));
let ready=false;for(let i=0;i<30;i++){try{const r=await fetch('http://localhost:3000/api/session');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}
let code=1;try{if(!ready)throw Error('server did not start');code=await new Promise(resolve=>{const test=spawn(process.execPath,[process.argv[2]],{stdio:'inherit'});test.on('exit',c=>resolve(c??1));});}finally{try{process.kill(-server.pid,'SIGTERM');}catch{}}
process.exit(code);
