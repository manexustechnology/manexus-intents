export type Token = { assetId:string; symbol:string; blockchain:string; decimals:number; price:number };
export const fixtures:Token[] = [
{assetId:'sample-usdc',symbol:'USDC',blockchain:'eth',decimals:6,price:1},
{assetId:'sample-near',symbol:'NEAR',blockchain:'near',decimals:24,price:3.2},
{assetId:'sample-btc',symbol:'BTC',blockchain:'btc',decimals:8,price:68000},
{assetId:'sample-eth',symbol:'ETH',blockchain:'eth',decimals:18,price:3200},
{assetId:'sample-sol',symbol:'SOL',blockchain:'sol',decimals:9,price:150}];
export function validAmount(value:string,decimals=8):boolean {return /^(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length<=32 && Number(value)>0 && Number(value)<=1e12 && (value.split('.')[1]?.length??0)<=decimals;}
export function validAddress(address:string,chain:string):boolean {if(chain==='eth')return /^0x[a-fA-F0-9]{40}$/.test(address); if(chain==='near')return /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(address); if(chain==='sol')return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address); return false;}
export type RequestData={address:string;amount:string;chain:string;symbol:string};
export function validateRequest(data:RequestData):boolean {return ['USDC','NEAR','ETH','SOL'].includes(data.symbol)&&((data.chain==='eth'&&['USDC','ETH'].includes(data.symbol))||(data.chain==='near'&&data.symbol==='NEAR')||(data.chain==='sol'&&data.symbol==='SOL'))&&validAddress(data.address,data.chain)&&validAmount(data.amount,data.symbol==='USDC'?6:8);}
export function parseRequest(hash:string):RequestData|null {try{const p=new URLSearchParams(hash.replace(/^#/,''));const d={address:p.get('address')??'',amount:p.get('amount')??'',chain:p.get('chain')??'',symbol:p.get('symbol')??''};return validateRequest(d)?d:null;}catch{return null}}
export function requestHash(data:RequestData):string {if(!validateRequest(data))throw Error('Invalid request');return '#'+new URLSearchParams(data).toString();}
export function estimate(amount:string,from:Token,to:Token,slippage:number){if(!validAmount(amount,Math.min(from.decimals,8))||from.assetId===to.assetId||![0.1,0.5,1].includes(slippage)||from.price<=0||to.price<=0)throw Error('Check your amount and asset pair.'); const output=Number(amount)*from.price/to.price;return {output,minimum:output*(1-slippage/100)};}
export const escapeHTML=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
