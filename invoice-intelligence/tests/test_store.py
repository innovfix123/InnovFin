"""Unit tests for core.store."""

from core.store import InMemoryStore, JsonlStore


def test_in_memory_store_get_put_contains():
    store = InMemoryStore()
    assert not store.contains("k")
    assert store.get("k", "default") == "default"
    store.put("k", 42)
    assert store.contains("k")
    assert store.get("k") == 42
    assert len(store) == 1


def test_add_returns_true_only_when_new():
    store = InMemoryStore()
    assert store.add("hash1") is True
    assert store.add("hash1") is False
    assert store.contains("hash1")


def test_jsonl_store_persists_across_instances(tmp_path):
    path = tmp_path / "state" / "dedup.jsonl"
    store = JsonlStore(path)
    store.put("msg-1", {"count": 3})
    store.add("msg-2")

    reloaded = JsonlStore(path)
    assert reloaded.get("msg-1") == {"count": 3}
    assert reloaded.contains("msg-2")
    assert len(reloaded) == 2


def test_jsonl_store_last_write_wins(tmp_path):
    path = tmp_path / "vh.jsonl"
    store = JsonlStore(path)
    store.put("amazon.in", 1)
    store.put("amazon.in", 5)
    reloaded = JsonlStore(path)
    assert reloaded.get("amazon.in") == 5


def test_jsonl_store_tolerates_corrupt_line(tmp_path):
    path = tmp_path / "corrupt.jsonl"
    path.write_text('{"k": "good", "v": 1}\nNOT JSON\n', encoding="utf-8")
    store = JsonlStore(path)
    assert store.get("good") == 1
    assert len(store) == 1
