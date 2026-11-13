import adapter from '../../desk/adapter.cjs';

export default async function handler(request) {
  if (request.method !== 'POST') return new Response(null,{status:405,headers:{Allow:'POST'}});
  try {
    const text=await request.text();
    if(text.length>250000) return Response.json({detail:'Pricing request is too large.'},{status:413});
    const {csv,markup}=JSON.parse(text);
    if(typeof csv!=='string' || (markup!==null && (!Number.isFinite(markup)||markup<0))) {
      return Response.json({detail:'Invalid pricing input.'},{status:422});
    }
    return Response.json(adapter.price({csv,markup,name:'Sandbox draft'}),{headers:{'Cache-Control':'no-store'}});
  }catch{
    return Response.json({detail:'Unable to price this takeoff.'},{status:422});
  }
}
