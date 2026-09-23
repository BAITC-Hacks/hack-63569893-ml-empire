import test from 'node:test';
import assert from 'node:assert/strict';
import { readAffect } from '../src/affect-model.ts';
import { serializeTrace } from '../src/supervisor-model.ts';

test('affect uses explicit supported server fields only, never infers from words', () => {
  assert.equal(readAffect({transcript:'angry',emotion:'angry'}), null);
  assert.deepEqual(readAffect({affect:{emotion:'concerned',response_tone:'empathetic',source:'audio',confidence:.8}}),
    {emotion:'concerned',tone:'empathetic',source:'audio',confidence:.8});
  assert.deepEqual(readAffect({affect:{emotion:'neutral',response_tone:'secret',source:'unknown',confidence:12,api_key:'secret'}}),
    {emotion:'neutral',tone:null,source:null,confidence:null});
  assert.equal(readAffect({affect:{emotion:'secret',response_tone:'secret'}}), null);
});

test('trace export preserves canonical affect names and drops unrecognized provider data', () => {
  const trace = { affect: { emotion:'concerned', response_tone:'calm', source:'text', confidence:.6, api_key:'not-for-export', explanation:'private details' } };
  const output = JSON.parse(serializeTrace({id:'qa',mode:'text',text:'test',language:'ru',reply:'test',status:'answered',route:null,preview:null,trace}));
  assert.deepEqual(readAffect(output.trace), readAffect(trace));
  assert.ok(!JSON.stringify(output).includes('not-for-export'));
  assert.ok(!JSON.stringify(output).includes('private details'));
});
