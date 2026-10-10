import assert from 'node:assert/strict';
import { playbackTime, mergeFlowPosts, appendFlowPage } from '../src/features/loop/flowPlayback.js';

for (const [seconds, text] of [[NaN,'0:00'],[Infinity,'0:00'],[-3,'0:00'],[8.9,'0:08'],[65,'1:05'],[3605,'1:00:05']]) {
  assert.equal(playbackTime(seconds),text);
}
const first=[{id:1},{id:2}];
assert.deepEqual(mergeFlowPosts(first,[{id:2},{id:3},{id:3},{id:4}]),[{id:1},{id:2},{id:3},{id:4}]);
assert.deepEqual(first,[{id:1},{id:2}], 'Pagination never mutates existing posts');
assert.deepEqual(mergeFlowPosts([],[]),[]);
let history=[];
for(let cycle=1;cycle<=25;cycle++) {
 const appended=appendFlowPage(history,[{id:1},{id:2},{id:2},{id:3}],cycle,Math.max(0,history.length-2));
 const focused=history.at(-2)?.flowKey;
 const previous=history.length-2;
 history=appended.posts;
 assert.ok(history.length<=60,'history stays bounded across rounds');
 assert.equal(new Set(history.map(post=>post.flowKey)).size,history.length,'distinct occurrences, no in-round duplicates');
 if(focused)assert.equal(history[previous-appended.removed].flowKey,focused,'trim preserves reader');
 assert.equal(history.at(-1).flowKey,`${cycle}:3`,'posts may reappear after completing a round');
}
assert.deepEqual(appendFlowPage(history,[{id:3}],25,history.length-1).posts,history,'retried page does not duplicate posts');
const full=Array.from({length:60},(_,index)=>({id:index+1,flowKey:`1:${index+1}`}));
const late=appendFlowPage(full,[{id:61},{id:62}],1,0);
assert.equal(late.deferred,true,'late retry while back-scrolling waits for buffer room');
assert.equal(late.posts,full,'no unseen or focused posts discarded');
assert.equal(appendFlowPage(full,[{id:61},{id:62}],1,58).deferred,undefined,'same page can be consumed on reaching the end');
console.log('PASS Flow clock formatting, invalid durations, ordered pagination and duplicate-page entries.');
