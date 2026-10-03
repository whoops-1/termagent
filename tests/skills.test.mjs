import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { loadSkills, selectSkills, formatSkills } from '../dist/skills/loader.js'

test('skill loader exposes descriptors without loading full bodies', async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'termagent-skills-'))
 try{
  const dir=path.join(root,'.termagent','skills','testing'); await mkdir(dir,{recursive:true})
  await writeFile(path.join(dir,'SKILL.md'),'---\ndescription: Run focused tests\n---\n# Testing\nVERY_LARGE_BODY_MARKER\n')
  const skills=await loadSkills(root)
  assert.equal(skills.length,1)
  assert.equal(skills[0].description,'Run focused tests')
  assert.equal('content' in skills[0],false)
  assert.equal(JSON.stringify(skills).includes('VERY_LARGE_BODY_MARKER'),false)
  assert.equal(selectSkills(skills,'run focused tests')[0].name,'testing')
  assert.match(formatSkills(skills),/testing: Run focused tests/)
  assert.doesNotMatch(formatSkills(skills),/VERY_LARGE_BODY_MARKER/)
 }finally{await rm(root,{recursive:true,force:true})}
})
