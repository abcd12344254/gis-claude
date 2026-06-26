"""
====== ChromaDB 向量存储 ======

本地向量数据库，零配置。用于 GIS 知识文档的语义检索。
存储位置: server/rag/chroma_data/
"""

import os
from pathlib import Path
from typing import Optional

try:
    import chromadb
    from chromadb.config import Settings
    _HAS_CHROMADB = True
except ImportError:
    _HAS_CHROMADB = False

_COLLECTION_KNOWLEDGE = "gis_knowledge"
_COLLECTION_DOCUMENTS = "gis_documents"
_DATA_DIR = Path(__file__).parent / "chroma_data"

_client: Optional[chromadb.PersistentClient] = None


def _get_client() -> chromadb.PersistentClient:
    global _client
    if _client is None:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(
            path=str(_DATA_DIR),
            settings=Settings(anonymized_telemetry=False),
        )
    return _client


def get_collection(name: str):
    """获取或创建 collection"""
    client = _get_client()
    try:
        return client.get_collection(name)
    except Exception:
        return client.create_collection(name)


def search_knowledge(query: str, top_k: int = 5, knowledge_type: str = "") -> list[dict]:
    """搜索 GIS 领域知识"""
    col = get_collection(_COLLECTION_KNOWLEDGE)
    if col.count() == 0:
        return []

    where = None
    if knowledge_type:
        where = {"type": knowledge_type}

    results = col.query(query_texts=[query], n_results=top_k, where=where)
    return _format_results(results)


def search_documents(query: str, top_k: int = 3, doc_type: str = "") -> list[dict]:
    """搜索技术文档"""
    col = get_collection(_COLLECTION_DOCUMENTS)
    if col.count() == 0:
        return []

    where = None
    if doc_type:
        where = {"type": doc_type}

    results = col.query(query_texts=[query], n_results=top_k, where=where)
    return _format_results(results)


def ingest_texts(texts: list[str], metadatas: list[dict], collection_name: str = _COLLECTION_KNOWLEDGE):
    """批量导入文本到向量库"""
    col = get_collection(collection_name)
    ids = [f"doc_{col.count() + i}" for i in range(len(texts))]
    col.add(documents=texts, metadatas=metadatas, ids=ids)
    return len(texts)


def ingest_file(file_path: str, collection_name: str = _COLLECTION_KNOWLEDGE,
                chunk_size: int = 500, chunk_overlap: int = 50) -> int:
    """
    从文件导入文档，自动切块。

    支持: .md, .txt, .py, .json
    策略: 按自然段落切分，保证每块不超过 chunk_size 字符
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    content = path.read_text(encoding="utf-8")

    # 按段落切分
    paragraphs = content.split("\n\n")
    chunks = []
    current = ""
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        if len(current) + len(p) < chunk_size:
            current += p + "\n\n"
        else:
            if current.strip():
                chunks.append(current.strip())
            current = p + "\n\n"
    if current.strip():
        chunks.append(current.strip())

    col = get_collection(collection_name)
    ids = [f"{path.stem}_{i}" for i in range(len(chunks))]
    metas = [{"source": str(path), "doc_name": path.name, "chunk": i, "type": path.suffix}
             for i in range(len(chunks))]

    col.add(documents=chunks, metadatas=metas, ids=ids)
    return len(chunks)


def get_stats() -> dict:
    """返回向量库统计信息"""
    k_col = get_collection(_COLLECTION_KNOWLEDGE)
    d_col = get_collection(_COLLECTION_DOCUMENTS)
    return {
        "knowledge_docs": k_col.count(),
        "documents": d_col.count(),
        "storage_path": str(_DATA_DIR),
    }


def _format_results(results: dict) -> list[dict]:
    """格式化查询结果"""
    if not results or not results.get("documents") or not results["documents"][0]:
        return []
    docs = results["documents"][0]
    metas = results.get("metadatas", [None])[0] or [None] * len(docs)
    distances = results.get("distances", [None])[0] or [None] * len(docs)
    formatted = []
    for i, (doc, meta, dist) in enumerate(zip(docs, metas, distances)):
        item = {"content": doc[:800], "rank": i + 1}
        if meta:
            item["metadata"] = meta
        if dist is not None:
            item["relevance"] = round(1.0 / (1.0 + dist), 4)  # 转换距离为相似度
        formatted.append(item)
    return formatted
