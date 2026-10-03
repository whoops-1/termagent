import fs from 'node:fs'
import { TerminalUI } from '../dist/cli/ui.js'
import { stripAnsi } from '../dist/design-system/ansi.js'

function output(width, height) {
  return { columns: width, rows: height, writes: [], write(chunk) { this.writes.push(String(chunk)); return true }, on() {}, off() {}, last: '' }
}
function latestFrame(out) { return out.writes.at(-1) || '' }
function prep(width,height) {
  const out=output(width,height)
  const input={isTTY:true,setRawMode(){return input},resume(){return input},pause(){return input},setEncoding(){return input},on(){},off(){}}
  const ui=new TerminalUI({title:'visual',model:'mock-model',provider:'openai-compatible',mode:'build',cwd:process.cwd(),output:out,input})
  ui.enter(); ui.addUser('Keep this transcript visible while the agent waits for a decision.'); ui.startAssistant();
  return {ui,out,input}
}

{
  const {ui,out}=prep(96,30)
  ui.startTool('edit_file',{path:'src/demo.ts',oldText:'const x = 1',newText:'const x = 2'})
  void ui.requestPermission({tool:{name:'edit_file',description:'edit',risk:'write',schema:{type:'object'}},args:{path:'src/demo.ts',oldText:'const x = 1',newText:'const x = 2'}})
  await new Promise(r=>setTimeout(r,80))
  fs.writeFileSync('phase12d-permission.ansi', latestFrame(out))
  fs.writeFileSync('phase12d-permission.txt', stripAnsi(latestFrame(out)))
  ui.leave()
}

{
  const {ui,out}=prep(96,30)
  void ui.requestQuestion([{header:'Decision',question:'Choose the implementation approach for this terminal UI surface.',options:[{label:'Reuse the existing shared surface',description:'Use the common dock primitives.'},{label:'Add a specialized surface',description:'Only when the shared primitive cannot express the interaction.'},{label:'Keep the implementation',description:'Preserve behavior and avoid visual changes.'},{label:'Type your own answer',description:'Provide a custom answer.'}],multi:false,custom:true}])
  await new Promise(r=>setTimeout(r,80))
  fs.writeFileSync('phase12d-question.ansi', latestFrame(out))
  fs.writeFileSync('phase12d-question.txt', stripAnsi(latestFrame(out)))
  ui.leave()
}
