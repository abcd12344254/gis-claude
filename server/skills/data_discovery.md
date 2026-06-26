---
name: data_discovery
version: "1.0"
description: 数据发现策略——协调资源目录与Agentic RAG，实现数据获取与知识检索的智能编排
triggers:
  - 查询
  - 搜索
  - 获取数据
  - 加载数据
  - 查一下
  - 帮我找
  - 有没有.*数据
  - 什么是
  - 如何
  - 怎么
dependencies:
  - list_resources
  - get_resource_handle
  - search_knowledge
  - search_documents
---

## 数据发现策略

### 核心分工

| 需求类型 | 使用工具 | 说明 |
|----------|----------|------|
| 需要GIS数据资源 | 资源目录 `list_resources` / `get_resource_handle` | 获取空间数据（文件/数据库/服务） |
| 需要专业知识 | Agentic RAG `search_knowledge` / `search_documents` | 检索GIS概念、方法、最佳实践 |
| 数据+知识混合 | 两者协同 | 先查知识理解方法 → 再获取数据执行 |

### 规则

**数据需求 → 资源目录：**
- 用户需要获取GIS数据资源（如"获取行政区划数据"、"加载路网数据"）
- 使用 `list_resources` 查询资源清单，发现可用资源
- 使用 `get_resource_handle` 获取资源的访问路径
- 资源路径包含资源的具体获取方式（文件路径/数据库连接/服务URL）

**知识需求 → Agentic RAG：**
- 用户需要GIS专业知识（如"什么是缓冲区分析"、"如何选择坐标系"）
- 使用 `search_knowledge` 检索GIS领域知识
- 使用 `search_documents` 检索技术文档与操作手册
- 支持多轮迭代检索，确保返回相关知识

**混合需求 → 协同调用：**
- 用户同时需要数据与知识时，分别调用两套工具
- 先通过知识检索理解分析方法，再通过资源目录获取数据

### 外部数据获取

当本地资源目录没有匹配资源时，应通过以下外部数据源获取：

| 数据源 | 工具 | 适用场景 |
|--------|------|----------|
| OpenStreetMap | `search_gis_data` / `query_osm` | 全球矢量数据（行政边界、POI、路网、水系等） |
| 高德地图 | `search_gis_data` / `search_poi` | 国内POI、地理编码（GCJ-02坐标系） |
| 本地文件 | `[LOCAL:文件名]` | 预置的本地GeoJSON数据 |
| Wikidata | `search_gis_data` | 自然地物、地理实体元数据 |

### 执行流程

```
用户请求
    │
    ▼
分析需求类型
    │
    ├─ 数据需求 → list_resources → 找到? 
    │               ├─ 是 → get_resource_handle → 返回资源路径
    │               └─ 否 → search_gis_data (OSM/高德/Wikidata)
    │
    ├─ 知识需求 → search_knowledge → 找到?
    │               ├─ 是 → 返回知识片段
    │               └─ 否 → 调整查询词重试 (最多3轮)
    │
    └─ 混合需求 → 先 search_knowledge 理解方法
                   → 再 list_resources 获取数据
                   → 执行分析
```
