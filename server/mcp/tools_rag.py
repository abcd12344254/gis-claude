"""
====== Agentic RAG MCP 工具 ======

基于 ChromaDB 的知识检索工具。
search_knowledge: GIS 领域知识检索
search_documents: 技术文档检索
ingest_document: 文档导入（未来批量导入用）
"""

from mcp.registry import MCPToolDef
from rag.vector_store import search_knowledge as _search_knowledge
from rag.vector_store import search_documents as _search_documents
from rag.vector_store import ingest_file, get_stats


async def _handle_search_knowledge(params: dict) -> dict:
    query = params.get("query", "")
    top_k = params.get("top_k", 5)
    knowledge_type = params.get("knowledge_type", "")

    if not query.strip():
        return {"results": [], "message": "查询为空"}

    results = _search_knowledge(query, top_k, knowledge_type)

    return {
        "results": results,
        "total": len(results),
        "query": query,
        "note": "向量库为空" if not results else f"返回 {len(results)} 条结果",
    }


async def _handle_search_documents(params: dict) -> dict:
    query = params.get("query", "")
    top_k = params.get("top_k", 3)
    doc_type = params.get("doc_type", "")

    if not query.strip():
        return {"results": [], "message": "查询为空"}

    results = _search_documents(query, top_k, doc_type)

    return {
        "results": results,
        "total": len(results),
        "query": query,
    }


async def _handle_ingest(params: dict) -> dict:
    """导入文档到向量库"""
    file_path = params.get("file_path", "")
    collection = params.get("collection", "gis_knowledge")

    try:
        count = ingest_file(file_path, collection)
        return {"success": True, "chunks": count, "file": file_path, "collection": collection}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _handle_rag_stats(params: dict) -> dict:
    return get_stats()


def register_rag_tools(registry):
    registry.register(MCPToolDef(
        name="search_knowledge",
        description="检索 GIS 领域知识。从向量库中查询 GIS 概念、方法、最佳实践。支持按知识类型筛选。",
        category="rag",
        parameters={
            "query": {"type": "string", "required": True, "description": "检索问题（自然语言）"},
            "top_k": {"type": "integer", "required": False, "description": "返回数量（默认5）"},
            "knowledge_type": {"type": "string", "required": False, "description": "知识类型筛选（可选）"},
        },
        returns={"type": "object", "description": "{results: [{content, relevance, metadata}]}"},
        examples=['{"query": "什么是缓冲区分析"}', '{"query": "坐标转换注意事项", "top_k": 3}'],
        handler=_handle_search_knowledge,
    ))
    registry.register(MCPToolDef(
        name="search_documents",
        description="检索技术文档。从向量库中查询操作手册、技术规范、项目文档。",
        category="rag",
        parameters={
            "query": {"type": "string", "required": True, "description": "检索问题（自然语言）"},
            "doc_type": {"type": "string", "required": False, "description": "文档类型筛选（可选）"},
            "top_k": {"type": "integer", "required": False, "description": "返回数量（默认3）"},
        },
        returns={"type": "object", "description": "{results: [{content, relevance, metadata}]}"},
        examples=['{"query": "如何配置高德API"}'],
        handler=_handle_search_documents,
    ))
    registry.register(MCPToolDef(
        name="ingest_document",
        description="导入文档到知识库。支持 .md / .txt / .py / .json。自动按段落切分为向量块。",
        category="rag",
        parameters={
            "file_path": {"type": "string", "required": True, "description": "文档文件路径"},
            "collection": {"type": "string", "required": False, "description": "目标collection（默认gis_knowledge）"},
        },
        returns={"type": "object", "description": "{success, chunks, file, collection}"},
        examples=['{"file_path": "docs/gis_guide.md"}'],
        handler=_handle_ingest,
    ))
    registry.register(MCPToolDef(
        name="rag_stats",
        description="查询向量库统计信息：已存储的文档数、存储位置等。",
        category="rag",
        parameters={},
        returns={"type": "object", "description": "{knowledge_docs, documents, storage_path}"},
        handler=_handle_rag_stats,
    ))
