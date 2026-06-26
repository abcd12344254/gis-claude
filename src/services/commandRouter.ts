/**
 * 直接命令路由器
 *
 * 检测用户输入是否为已知格式的结构化指令。
 * 如果是 → 直接执行，跳过 DeepSeek 大模型。
 * 如果不是 → 照常发给 DeepSeek。
 */

// ====== 类型定义 ======

export type CommandMode = 'direct' | 'mixed' | 'pass-through';

export interface CommandDetectionResult {
  mode: CommandMode;
}

/**
 * 斜杠命令定义
 */
export interface SlashCommandDef {
  cmd: string;
  aliases?: string[];
  usage: string;
  description: string;
  example: string;
}

// ====== 斜杠命令表（单一事实来源） ======

const SLASH_COMMANDS: SlashCommandDef[] = [
  // ── OSM 数据查询 ──
  { cmd: 'osm', usage: '/osm <类型> <地名>', description: '查询OpenStreetMap数据', example: '/osm boundary 武汉市' },

  // ── 空间分析 ──
  { cmd: 'buffer', usage: '/buffer <地名|图层名> [半径]', description: '创建缓冲区（默认5km）', example: '/buffer 武汉市 10km' },
  { cmd: 'area', usage: '/area <图层名>', description: '计算面积', example: '/area 武汉市' },
  { cmd: 'centroid', usage: '/centroid <图层名>', description: '计算几何中心', example: '/centroid 武汉市' },
  { cmd: 'bbox', usage: '/bbox <图层名>', description: '计算边界框', example: '/bbox 武汉市' },
  { cmd: 'convex', usage: '/convex <图层名>', description: '凸包分析', example: '/convex 武汉市' },
  { cmd: 'simplify', usage: '/simplify <图层名> [容差]', description: '简化几何（减少顶点）', example: '/simplify 武汉市 0.01' },
  { cmd: 'intersect', usage: '/intersect <图层A> <图层B>', description: '相交分析', example: '/intersect 武汉市 洪山区' },
  { cmd: 'union', usage: '/union <图层名>', description: '合并所有要素', example: '/union 武汉市' },
  { cmd: 'grid', usage: '/grid [图层名] [格网大小km]', description: '生成渔网格网', example: '/grid 武汉市 10' },
  { cmd: 'density', usage: '/density <图层名>', description: '点密度分析', example: '/density 武汉市' },
  { cmd: 'distance', usage: '/distance <图层名>', description: '计算点之间的总距离', example: '/distance 武汉市' },
  { cmd: 'classify', usage: '/classify <图层名> <字段> [配色]', description: '按数值字段分层着色', example: '/classify 武汉市 admin_level' },
  { cmd: 'dbscan', usage: '/dbscan <图层名> [eps]', description: 'DBSCAN点聚类', example: '/dbscan 武汉市 1.0' },
  { cmd: 'kde', usage: '/kde <图层名> [带宽]', description: '核密度估计热力图', example: '/kde 武汉市 1.0' },
  { cmd: 'idw', usage: '/idw <图层名> <字段>', description: 'IDW空间插值', example: '/idw 武汉市 population' },
  { cmd: 'zonal', usage: '/zonal <区域图层> <点图层> <字段>', description: '分区统计', example: '/zonal 武汉市 地震数据 admin_level' },

  // ── 路径规划 ──
  { cmd: 'route', usage: '/route <起点> <终点> [方式]', description: '路径规划（driving/walking/cycling）', example: '/route 北京 上海 driving' },

  // ── 地图操作 ──
  { cmd: 'zoom', usage: '/zoom <lng> <lat> [zoom]', description: '飞到指定坐标', example: '/zoom 116.397 39.909 14' },
  { cmd: 'clear', aliases: ['cls'], usage: '/clear', description: '清空所有图层', example: '/clear' },

  // ── 本地文件 ──
  { cmd: 'local', usage: '/local <文件名>', description: '加载本地GeoJSON文件', example: '/local 邯郸区县' },

  // ── 灾害/环境数据 ──
  { cmd: 'earthquake', aliases: ['eq'], usage: '/earthquake [最小震级]', description: '查询当前视野近90天地震', example: '/earthquake 4.0' },
  { cmd: 'weather', usage: '/weather', description: '查询当前视野实时天气+7天预报', example: '/weather' },

  // ── 帮助 ──
  { cmd: 'help', usage: '/help', description: '显示所有可用命令', example: '/help' },
];

// ====== 括号指令模式 ======

/** 所有已知的括号指令前缀 */
const BRACKET_PREFIXES = ['OSM', 'ANALYSIS', 'ROUTE', 'HAZARD', 'QUERY', 'LOCAL', 'MAP', 'SPACETIME'];

/**
 * 整个字符串是否都是括号指令行（或空行）
 */
const BRACKET_LINE = new RegExp(
  `^\\[(${BRACKET_PREFIXES.join('|')}):[^\\]]+\\]\\s*$`,
  'm'
);

const CONTAINS_BRACKET = new RegExp(
  `\\[(${BRACKET_PREFIXES.join('|')}):[^\\]]+\\]`
);

// ====== 核心函数 ======

/**
 * 检测用户输入的模式
 *
 * @returns 'direct' — 可跳过 DeepSeek 直接执行
 *          'mixed'  — 包含指令但也混有自然语言，应发给 DeepSeek
 *          'pass-through' — 纯自然语言，正常走 DeepSeek
 */
export function detectCommandMode(input: string): CommandDetectionResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { mode: 'pass-through' };
  }

  // 1. 斜杠命令 → 直接执行
  if (trimmed.startsWith('/')) {
    return { mode: 'direct' };
  }

  // 2. 所有非空行都是括号指令 → 直接执行
  const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
  const allBrackets = lines.every(line => {
    return BRACKET_LINE.test(line.trim());
  });

  if (allBrackets && lines.length > 0) {
    return { mode: 'direct' };
  }

  // 3. 包含括号指令但混有自然语言 → 发给 DeepSeek 解释
  const hasBrackets = CONTAINS_BRACKET.test(trimmed);
  const remainder = trimmed.replace(CONTAINS_BRACKET, '').trim();
  // 去掉括号指令后，如果还有中文/英文内容（不是纯标点），就是混合模式
  const hasNaturalLanguage = /[一-鿿\w]{2,}/.test(remainder);

  if (hasBrackets && hasNaturalLanguage) {
    return { mode: 'mixed' };
  }

  // 4. 只有括号但剩余是纯标点/空白 → 也视为直接执行
  if (hasBrackets && !hasNaturalLanguage) {
    return { mode: 'direct' };
  }

  // 5. 纯自然语言
  return { mode: 'pass-through' };
}

/**
 * 将斜杠命令转换为括号指令格式
 *
 * @example
 *   convertSlashToBracket('/osm boundary 武汉市')
 *   // → '[OSM:boundary:武汉市]'
 *
 *   convertSlashToBracket('/buffer 武汉市 10km')
 *   // → '[ANALYSIS:buffer:武汉市:10km]'
 */
export function convertSlashToBracket(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return trimmed;

  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const results: string[] = [];

  for (const line of lines) {
    if (!line.startsWith('/')) {
      results.push(line);
      continue;
    }

    // 去掉开头的 /
    const inner = line.slice(1);
    const spaceIdx = inner.search(/\s/);
    const cmd = spaceIdx >= 0 ? inner.slice(0, spaceIdx).toLowerCase() : inner.toLowerCase();
    const args = spaceIdx >= 0 ? inner.slice(spaceIdx + 1).trim() : '';

    const converted = convertOneSlash(cmd, args);
    results.push(converted ?? line);
  }

  return results.join('\n');
}

/**
 * 转换单个斜杠命令
 */
function convertOneSlash(cmd: string, args: string): string | null {
  switch (cmd) {
    // ── OSM 命令 ──
    case 'osm': {
      const subParts = args.split(/\s+/);
      const action = subParts[0];   // boundary | feature | outline | poi-in | districts | ...
      const remaining = subParts.slice(1).join(' ');
      if (action === 'poi-in') {
        // /osm poi-in 武汉 大学 → [OSM:poi-in:武汉:大学]
        const poiParts = remaining.split(/\s+/);
        const place = poiParts[0];
        const type = poiParts.slice(1).join('_');
        return `[OSM:poi-in:${place}:${type}]`;
      }
      if (action === 'roads-in' || action === 'water-in' || action === 'green-in' || action === 'buildings-in' || action === 'railways-in') {
        const sp = remaining.split(/\s+/);
        const place = sp[0];
        const sub = sp.slice(1).join('_');
        return sub ? `[OSM:${action}:${place}:${sub}]` : `[OSM:${action}:${place}]`;
      }
      return `[OSM:${action}:${remaining}]`;
    }

    // ── 空间分析命令（一对一映射） ──
    case 'buffer': {
      const sp = args.split(/\s+/);
      return sp.length >= 2
        ? `[ANALYSIS:buffer:${sp[0]}:${sp.slice(1).join(' ')}]`
        : `[ANALYSIS:buffer:${args || ''}]`;
    }
    case 'area':
      return `[ANALYSIS:area:${args.split(/\s+/)[0] || ''}]`;
    case 'centroid':
      return `[ANALYSIS:centroid:${args.split(/\s+/)[0] || ''}]`;
    case 'bbox':
      return `[ANALYSIS:bbox:${args.split(/\s+/)[0] || ''}]`;
    case 'convex':
      return `[ANALYSIS:convex:${args.split(/\s+/)[0] || ''}]`;
    case 'simplify': {
      const sp = args.split(/\s+/);
      return `[ANALYSIS:simplify:${sp[0] || ''}:${sp[1] || '0.01'}]`;
    }
    case 'intersect': {
      const sp = args.split(/\s+/);
      return `[ANALYSIS:intersect:${sp[0] || ''}|${sp[1] || ''}]`;
    }
    case 'union':
      return `[ANALYSIS:union:${args.split(/\s+/)[0] || ''}]`;
    case 'grid': {
      const sp = args.split(/\s+/);
      if (sp.length === 0) return `[ANALYSIS:grid::10]`;
      if (sp.length === 1) return `[ANALYSIS:grid:${sp[0]}:10]`;
      return `[ANALYSIS:grid:${sp[0]}:${sp[1]}]`;
    }
    case 'density':
      return `[ANALYSIS:density:${args.split(/\s+/)[0] || ''}]`;
    case 'distance':
      return `[ANALYSIS:distance:${args.split(/\s+/)[0] || ''}]`;
    case 'classify': {
      const sp = args.split(/\s+/);
      const layer = sp[0] || '';
      const field = sp[1] || '';
      const ramp = sp[2] || '';
      return `[ANALYSIS:classify:${layer}:${field}${ramp ? ':' + ramp : ''}]`;
    }
    case 'dbscan': {
      const sp = args.split(/\s+/);
      return `[ANALYSIS:dbscan:${sp[0] || ''}:${sp[1] || '1.0'}]`;
    }
    case 'kde': {
      const sp = args.split(/\s+/);
      return `[ANALYSIS:kde:${sp[0] || ''}:${sp[1] || '1.0'}]`;
    }
    case 'idw': {
      const sp = args.split(/\s+/);
      return `[ANALYSIS:idw:${sp[0] || ''}:${sp[1] || ''}]`;
    }
    case 'zonal': {
      const sp = args.split(/\s+/);
      const zoneLayer = sp[0] || '';
      const pointLayer = sp[1] || '';
      const field = sp[2] || '';
      return `[ANALYSIS:zonal:${zoneLayer}|${pointLayer}:${field}]`;
    }

    // ── 路径规划 ──
    case 'route': {
      const sp = args.split(/\s+/);
      const from = sp[0] || '';
      const to = sp[1] || '';
      const mode = sp[2] || 'driving';
      return `[ROUTE:${from}:${to}:${mode}]`;
    }

    // ── 地图操作 ──
    case 'zoom': {
      const sp = args.split(/\s+/);
      return `[MAP:zoomTo:${sp[0] || '0'},${sp[1] || '0'},${sp[2] || '14'}]`;
    }
    case 'clear':
    case 'cls':
      return '[MAP:clearLayers]';

    // ── 本地文件 ──
    case 'local':
      return `[LOCAL:${args}]`;

    // ── 灾害/环境 ──
    case 'earthquake':
    case 'eq':
      return `[HAZARD:earthquake${args ? ':' + args : ''}]`;
    case 'weather':
      return '[HAZARD:weather]';

    // ── 帮助 ──
    case 'help':
      return '__HELP__';

    // ── 未知命令 → 保持原样（让 DeepSeek 处理） ──
    default:
      return null;
  }
}

// ====== 帮助文本 ======

/**
 * 从命令表动态生成 /help 文本
 */
export function getHelpText(): string {
  const groups: { title: string; cmds: SlashCommandDef[] }[] = [
    { title: 'OSM 数据查询', cmds: SLASH_COMMANDS.filter(c => c.cmd === 'osm') },
    { title: '空间分析', cmds: SLASH_COMMANDS.filter(c =>
      ['buffer', 'area', 'centroid', 'bbox', 'convex', 'simplify', 'intersect', 'union', 'grid', 'density', 'distance', 'classify', 'dbscan', 'kde', 'idw', 'zonal'].includes(c.cmd)
    )},
    { title: '路径规划', cmds: SLASH_COMMANDS.filter(c => c.cmd === 'route') },
    { title: '地图操作', cmds: SLASH_COMMANDS.filter(c => ['zoom', 'clear'].includes(c.cmd)) },
    { title: '本地文件', cmds: SLASH_COMMANDS.filter(c => c.cmd === 'local') },
    { title: '灾害/环境数据', cmds: SLASH_COMMANDS.filter(c => ['earthquake', 'weather'].includes(c.cmd)) },
  ];

  let text = `## ⚡ 直接命令帮助\n\n`;
  text += `直接输入以下格式的命令可以**跳过 AI**，立即执行。AI 不会被调用，零延迟、零 Token 消耗。\n\n`;
  text += `> 💡 也可以直接用方括号格式：\`[OSM:boundary:武汉市]\`、\`[ANALYSIS:buffer:武汉市:5km]\` 等。\n\n`;

  for (const group of groups) {
    if (group.cmds.length === 0) continue;
    text += `### ${group.title}\n\n`;
    text += `| 命令 | 说明 | 示例 |\n`;
    text += `|------|------|------|\n`;
    for (const cmd of group.cmds) {
      text += `| \`${cmd.usage}\` | ${cmd.description} | \`${cmd.example}\` |\n`;
    }
    text += `\n`;
  }

  text += `### 缩写别名\n\n`;
  text += `| 命令 | 别名 |\n`;
  text += `|------|------|\n`;
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.aliases && cmd.aliases.length > 0) {
      text += `| \`/${cmd.cmd}\` | ${cmd.aliases.map(a => `\`/${a}\``).join(', ')} |\n`;
    }
  }

  return text;
}

/**
 * 从命令表中查找命令定义
 */
export function findSlashCommand(cmd: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find(
    c => c.cmd === cmd || (c.aliases && c.aliases.includes(cmd))
  );
}

/**
 * 获取所有斜杠命令列表（用于自动补全提示）
 */
export function getAllSlashCommands(): SlashCommandDef[] {
  return SLASH_COMMANDS;
}
