import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { preview } from 'vite';
import price from '../netlify/sandbox-functions/price.mjs';

await preview({preview:{host:'127.0.0.1',port:8766,strictPort:true}});
const proxy = createServer(async (req,res)=>{
  if(req.url==='/.netlify/functions/price'){
    const response=await price(new Request('http://127.0.0.1:8765'+req.url,{
      method:req.method,headers:req.headers,body:req.method==='POST'?Readable.toWeb(req):undefined,duplex:'half',
    }));
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const response=await fetch('http://127.0.0.1:8766'+req.url);
  res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/octet-stream'});
  res.end(Buffer.from(await response.arrayBuffer()));
});
proxy.listen(8765,'127.0.0.1');
