import fs from 'node:fs'
import { TerminalUI } from '../dist/cli/ui.js'
import { stripAnsi } from '../dist/design-system/ansi.js'
function wait(ms=25){return new Promise(r=>setTimeout(r,ms))}
function output(width,height){return {columns:width,rows:height,write(s){this.last=String(s);return true},on(){},off(){},last:''}}
const patch=['diff --git a/src/demo.ts b/src/demo.ts','--- a/src/demo.ts','+++ b/src/demo.ts','@@ -1,4 +1,5 @@',' import one','-const before = 1','+const before = 2','+const extra = true',' const after = 3'].join('\n')
const o90=output(90,30)
const ui90=new TerminalUI({title:'visual',model:'mock',provider:'openai-compatible',mode:'build',cwd:process.cwd(),output:o90})
ui90.enter(); ui90.startTool('edit_file',{path:'src/demo.ts'}); ui90.endTool('edit_file','edited', {diff:patch,fileDiff:{path:'src/demo.ts',additions:2,deletions:1}}); await wait(); fs.writeFileSync('phase12c-main-snapshot.txt', stripAnsi(o90.last)); fs.writeFileSync('phase12c-main-raw.ansi', o90.last); ui90.leave()
const o140=output(140,36)
const ui140=new TerminalUI({title:'visual',model:'mock',provider:'openai-compatible',mode:'build',cwd:process.cwd(),output:o140})
ui140.enter(); ui140.openWorkingTreeDiff({text:patch,files:[{path:'src/demo.ts',additions:2,deletions:1}],additions:2,deletions:1},'Working tree'); await wait(); ui140.onInspectorData('\r'); await wait(); fs.writeFileSync('phase12c-detail-snapshot.txt', stripAnsi(o140.last)); fs.writeFileSync('phase12c-detail-raw.ansi', o140.last); ui140.leave()
