import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferBudget } from '../dist/migrations/buffer-budget.js';

test('buffer reservations bound aggregate payload bytes and release after errors', async () => {
  const budget=new BufferBudget(128);let active=0,peak=0,finished=0;
  const jobs=Array.from({length:16},(_,i)=>budget.run(64,async()=>{
    active+=64;peak=Math.max(peak,active);
    try {await new Promise(resolve=>setTimeout(resolve,1));if(i===0)throw Error('Synthetic read interruption');}
    finally {active-=64;finished++;}
  }));
  const result=await Promise.allSettled(jobs);
  assert.equal(result.filter(r=>r.status==='rejected').length,1);
  assert.equal(peak,128);assert.equal(active,0);assert.equal(finished,16);
  assert.equal(await budget.run(128,async()=>true),true);
});

test('small buffers retain parallelism and invalid reservations never run', async()=>{
  const budget=new BufferBudget(128);let active=0,peak=0;
  await Promise.all(Array.from({length:16},()=>budget.run(4,async()=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;
  })));
  assert.equal(peak,16);
  for(const bytes of [-1,129,NaN,Infinity,0.1])await assert.rejects(()=>budget.run(bytes,async()=>assert.fail('Invalid reservation admitted')),/buffer allowance/);
});
