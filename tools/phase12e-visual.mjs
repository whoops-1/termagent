import fs from 'node:fs'
import { renderPicker } from '../dist/design-system/picker.js'
import { renderActivity } from '../dist/design-system/activity.js'
import { renderDockFrame } from '../dist/design-system/surfaces.js'
import { renderDiffFile } from '../dist/design-system/diff.js'
import { stripAnsi } from '../dist/design-system/ansi.js'
import { THEMES } from '../dist/design-system/theme.js'

const theme = THEMES.termagent
const cap='truecolor'
function write(name, rows, width, height){
  const out = rows.slice(0,height).map(r=>String(r).padEnd(width,' ')).join('\n')+'\n'
  fs.writeFileSync(name+'.ansi', out)
  fs.writeFileSync(name+'.txt', stripAnsi(out))
}

const pickerBase={
  options:Array.from({length:12},(_,i)=>({label:['/provider','/model','/plugins','/skills','/session','/doctor','/config','/history','/theme','/resume','/clear','/quit'][i],description:['Switch provider profile','Select the current model','Manage installed plugins','Browse discovered skills','Session actions','Run diagnostics','Open configuration','Search session history','Change UI theme','Resume a session','Clear the screen','Exit TermAgent'][i]})),
  selectedIndex:7,width:80,maxVisible:8,availableRows:20,title:'Commands',footer:'↑↓ select · Enter run · Esc close',commandLayout:true,
  commandNameWidth:24,commandDescriptionGap:2,commandItemPaddingLeft:3,commandItemPaddingRight:3,query:'',theme,capability:cap
}
write('/tmp/termagent12e-picker80',renderPicker(pickerBase),80,20)
write('/tmp/termagent12e-picker48',renderPicker({...pickerBase,width:48,commandLayout:'stacked',availableRows:16}),48,16)

const diffFile={path:'src/example.ts',patch:'--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,4 @@\n export const a = 1\n-export const b = 2\n+export const b = 3\n+export const c = 4',additions:2,deletions:1,status:'modified'}
write('/tmp/termagent12e-diff',renderDiffFile({width:80,file:diffFile,theme,capability:cap,view:'unified',maxRows:16}),80,16)
write('/tmp/termagent12e-dock',renderDockFrame({width:80,title:'Permission required',content:['→ Edit src/example.ts','Review the proposed changes before allowing this edit.'],footer:'←→ choose · Enter confirm · Esc reject',theme,capability:cap,tone:'warning',maxWidth:76}),80,8)

const activityRows=[
 renderActivity({width:80,phase:'thinking',label:'Thinking',elapsedSeconds:2,frame:1,theme,capability:cap}),
 renderActivity({width:80,phase:'writing',label:'Writing response',elapsedSeconds:4,frame:2,theme,capability:cap}),
 renderActivity({width:80,phase:'permission',label:'Permission required',elapsedSeconds:5,frame:0,theme,capability:cap}),
 renderActivity({width:80,phase:'done',label:'Completed',elapsedSeconds:6,frame:0,theme,capability:cap}),
 renderActivity({width:80,phase:'error',label:'Verification failed',elapsedSeconds:7,frame:0,theme,capability:cap})
]
write('/tmp/termagent12e-status',activityRows,80,8)
