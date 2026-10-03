import { writeFileSync, mkdirSync } from 'node:fs'
import { PluginManagerController } from './dist/cli/tui/plugin-manager.js'

const marketplace = {
  name: 'termagent-community', owner: 'Community',
  description: 'Curated development plugins for TermAgent.',
  source: { source: 'github', repo: 'example/termagent-community', ref: 'main' },
  status: 'ready', lastUpdated: '2026-09-27T10:00:00.000Z',
  revision: '0123456789abcdef0123456789abcdef01234567',
  digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  installLocation: '/home/user/.termagent/marketplaces/termagent-community',
  plugins: Array.from({ length: 12 }, (_, i) => ({
    name: i === 0 ? 'alpha-with-a-very-long-name-that-must-be-clipped' : `plugin-${String(i + 1).padStart(2, '0')}`,
    version: `1.0.${i}`,
    description: `Plugin ${i + 1} for terminal development, testing, and automation workflows.`,
    source: { source: 'github', repo: `example/plugin-${i + 1}`, ref: 'main' },
    category: 'development', tags: ['dev', 'terminal'], strict: true,
  })),
}

function snapshot() {
  return {
    plugins: [
      { id:'alpha@termagent-community', marketplace:'termagent-community', plugin:'alpha-with-a-very-long-name-that-must-be-clipped', source:'github', status:'update-available', enabled:true, version:'0.9.0', revision:'1111111111111111111111111111111111111111', digest:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', installPath:'/home/user/.termagent/plugins/alpha', components:{commands:0,agents:1,skills:2,mcp:0,hooks:0} },
      { id:'disabled@termagent-community', marketplace:'termagent-community', plugin:'disabled', source:'github', status:'installed', enabled:false, version:'2.0.0', revision:'2222222222222222222222222222222222222222', digest:'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', installPath:'/home/user/.termagent/plugins/disabled', components:{commands:1,agents:0,skills:0,mcp:0,hooks:1} },
      { id:'zebra@termagent-community', marketplace:'termagent-community', plugin:'zebra', source:'github', status:'installed', enabled:true, version:'1.2.3', revision:'fedcba9876543210fedcba9876543210fedcba98', digest:'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd', installPath:'/home/user/.termagent/plugins/zebra', components:{commands:3,agents:2,skills:4,mcp:1,hooks:2} },
    ],
    marketplaces: [marketplace],
    skills: [
      { id:'zebra:review', name:'review', description:'Review code changes carefully.', source:'plugin', pluginId:'zebra@termagent-community', pluginName:'zebra', marketplace:'termagent-community', version:'1.2.3', userInvocable:true },
      { id:'local:notes', name:'notes', description:'Organize project notes.', source:'project', userInvocable:true },
    ],
  }
}
const callbacks={
  refresh: async()=>snapshot(), togglePlugin:async()=>{}, removePlugin:async()=>{},
  installPlugin:async()=>({message:'installed'}), refreshMarketplace:async()=>{}, removeMarketplace:async()=>{},
  skillDetails: async id => ({...snapshot().skills.find(s=>s.id===id), path:'/home/user/project/.termagent/skills/review/SKILL.md', root:'/home/user/project/.termagent/skills/review', size:1842, mtimeMs:Date.now(), sha256:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', frontmatter:{description:'Review code changes carefully.', 'user-invocable':'true'}, warnings:[]}),
}

mkdirSync('/mnt/data/phase6-screenshots', {recursive:true})
const save = (name, c, width, height) => writeFileSync(`/mnt/data/phase6-screenshots/${name}.ansi`, c.render(width,height).join('\n'))

let c = new PluginManagerController(callbacks, snapshot(), 'plugins')
save('01-plugin-list-60x20', c, 60, 20)

c = new PluginManagerController(callbacks, snapshot(), 'plugins')
await c.handleKey('enter')
save('02-plugin-detail-80x24', c, 80, 24)

c = new PluginManagerController(callbacks, snapshot(), 'marketplaces')
await c.handleKey('enter'); await c.handleKey('enter'); await c.handleKey('i')
save('03-trust-confirm-60x20', c, 60, 20)

c = new PluginManagerController(callbacks, snapshot(), 'skills')
await c.handleKey('down'); await c.handleKey('enter')
save('04-skill-detail-80x24', c, 80, 24)

c = new PluginManagerController(callbacks, snapshot(), 'marketplaces')
await c.handleKey('enter')
save('05-marketplace-detail-80x24', c, 80, 24)
await c.handleKey('down'); await c.handleKey('enter')
save('06-marketplace-plugin-detail-80x24', c, 80, 24)

c = new PluginManagerController(callbacks, snapshot(), 'marketplaces')
await c.handleKey('enter')
save('07-marketplace-detail-60x20', c, 60, 20)

c = new PluginManagerController(callbacks, snapshot(), 'plugins')
await c.handleKey('enter'); await c.handleKey('x')
save('08-remove-confirm-60x20', c, 60, 20)
