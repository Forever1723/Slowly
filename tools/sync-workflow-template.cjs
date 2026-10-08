/*
 * 把 tools/build-offline.mjs 里内嵌的工作流模板，同步成
 * .github/workflows/build-apk.yml 的当前内容。
 *
 * 必须幂等：脚本要能反复运行。关键是先把模板**反转义**回原始 YAML，
 * 再重新转义写入 —— 直接在已转义的内容上再转义一次会让反斜杠翻倍。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = 'D:\\my questions\\Slowly'
const WORKFLOW_FILE = path.join(ROOT, '.github', 'workflows', 'build-apk.yml')
const TOOL = path.join(ROOT, 'tools', 'build-offline.mjs')

const START = '  const workflow = `'
const END = '`;\r\n  /* 只写仓库根目录这一份'
const END_LF = '`;\n  /* 只写仓库根目录这一份'

/** 模板字符串 -> 原始文本 */
function unescapeTemplate(s) {
  return s
    .replace(/\\\$\{/g, '${')
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\')
}

/** 原始文本 -> 模板字符串内容 */
function escapeTemplate(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
}

const src = fs.readFileSync(TOOL, 'utf8')
const startAt = src.indexOf(START)
if (startAt === -1) { console.error('找不到模板起点'); process.exit(1) }

let endAt = src.indexOf(END, startAt)
let endLen = END.length
if (endAt === -1) { endAt = src.indexOf(END_LF, startAt); endLen = END_LF.length }
if (endAt === -1) { console.error('找不到模板终点'); process.exit(1) }

const currentEscaped = src.slice(startAt + START.length, endAt)
const currentRaw = unescapeTemplate(currentEscaped)
const target = fs.readFileSync(WORKFLOW_FILE, 'utf8')

/* 用原始文本比较，判断是否真的需要改 */
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '')
if (norm(currentRaw) === norm(target)) {
  console.log('  · 模板与工作流文件已经一致，无需改动')
} else {
  const next = src.slice(0, startAt + START.length) + escapeTemplate(target) + src.slice(endAt)
  fs.writeFileSync(TOOL, next, 'utf8')
  console.log('  ✓ 模板已同步为工作流文件的内容（' + target.split('\n').length + ' 行）')
}

/* 自检：跑两次应当得到相同结果 */
const after = fs.readFileSync(TOOL, 'utf8')
const a2 = after.indexOf(START)
let e2 = after.indexOf(END, a2)
let l2 = END.length
if (e2 === -1) { e2 = after.indexOf(END_LF, a2); l2 = END_LF.length }
const roundTrip = unescapeTemplate(after.slice(a2 + START.length, e2))
console.log('  自检：模板反转义后与工作流文件一致 = ' + (norm(roundTrip) === norm(target)))

/* 关键内容检查 */
const checks = [
  ['"on":', 'on 必须带引号（YAML 会把裸 on 当布尔值）'],
  ['workflow_dispatch:', '有手动触发'],
  ['assembleRelease', '构建 release'],
  ['slowly-apk', '产物名'],
  ['sdkmanager', '自己装 SDK'],
]
let bad = 0
for (const [needle, why] of checks) {
  if (!roundTrip.includes(needle)) { console.log('  ✗ 模板缺少「' + why + '」'); bad++ }
}
console.log(bad === 0 ? '  ✓ 模板关键内容齐全' : '  ⚠ 有 ' + bad + ' 项缺失')
