"""A minimal evaluator of Gmail-style search queries against an EmailDocument.

Purpose: TEST/measure how the generated native rules would classify our labeled corpus.
It is an approximation of Gmail's semantics, not a full reimplementation — but it faithfully
models the operators we generate: from / to / subject / filename / has:attachment / in: /
label:, quoted phrases, bare words, OR, implicit AND, negation ('-'), and grouping '()'.

Crucially, like Gmail, it can only see email metadata + body text + attachment NAMES — never
attachment contents. That is exactly the limitation we want the tests to reflect.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

from core.email_document import EmailDocument

# Expand Gmail's compact grouped form ``op:(a OR b)`` -> ``(op:a OR op:b)`` so the parser
# only ever deals with simple atoms. Negation like ``-from:(a OR b)`` becomes
# ``-(from:a OR from:b)``. Idempotent on already-distributed queries.
_GROUP_OP_RE = re.compile(r"(\b\w+):\(([^()]*)\)")


def expand_grouped_ops(query: str) -> str:
    def repl(match: "re.Match[str]") -> str:
        op, inner = match.group(1), match.group(2)
        parts = [p.strip() for p in inner.split(" OR ") if p.strip()]
        return "(" + " OR ".join(f"{op}:{p}" for p in parts) + ")"

    prev = None
    while prev != query:
        prev = query
        query = _GROUP_OP_RE.sub(repl, query)
    return query

# ---------------------------------------------------------------------------
# Tokenizer: keeps quoted phrases intact, emits '(' ')' and '-' (before '(') as tokens.
# ---------------------------------------------------------------------------

def tokenize(query: str) -> List[str]:
    tokens: List[str] = []
    buf: List[str] = []
    i, n = 0, len(query)

    def flush():
        if buf:
            tokens.append("".join(buf))
            buf.clear()

    while i < n:
        ch = query[i]
        if ch == '"':
            # read to closing quote (inclusive) as part of the current token
            j = query.find('"', i + 1)
            if j == -1:
                j = n
            buf.append(query[i:j + 1])
            i = j + 1
        elif ch.isspace():
            flush()
            i += 1
        elif ch == "(":
            flush()
            tokens.append("(")
            i += 1
        elif ch == ")":
            flush()
            tokens.append(")")
            i += 1
        elif ch == "-" and not buf:
            # A '-' starting a token: standalone if it precedes '(' , else part of '-atom'.
            if i + 1 < n and query[i + 1] == "(":
                tokens.append("-")
                i += 1
            else:
                buf.append(ch)
                i += 1
        else:
            buf.append(ch)
            i += 1
    flush()
    return tokens


# ---------------------------------------------------------------------------
# AST
# ---------------------------------------------------------------------------

@dataclass
class Node:
    def eval(self, doc: EmailDocument) -> bool:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass
class And(Node):
    children: List[Node]

    def eval(self, doc):
        return all(c.eval(doc) for c in self.children)


@dataclass
class Or(Node):
    children: List[Node]

    def eval(self, doc):
        return any(c.eval(doc) for c in self.children)


@dataclass
class Not(Node):
    child: Node

    def eval(self, doc):
        return not self.child.eval(doc)


@dataclass
class Atom(Node):
    raw: str

    def eval(self, doc):
        return _eval_atom(self.raw, doc)


# ---------------------------------------------------------------------------
# Parser (recursive descent): OR is lowest precedence, whitespace = implicit AND.
# ---------------------------------------------------------------------------

class _Parser:
    def __init__(self, tokens: List[str]):
        self.tokens = tokens
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def next(self):
        tok = self.peek()
        self.pos += 1
        return tok

    def parse(self) -> Node:
        node = self.parse_or()
        return node if node is not None else And([])

    def parse_or(self) -> Node:
        nodes = [self.parse_and()]
        while self.peek() == "OR":
            self.next()
            nodes.append(self.parse_and())
        return nodes[0] if len(nodes) == 1 else Or(nodes)

    def parse_and(self) -> Node:
        nodes = []
        while True:
            tok = self.peek()
            if tok is None or tok == ")" or tok == "OR":
                break
            nodes.append(self.parse_factor())
        if not nodes:
            return And([])  # empty
        return nodes[0] if len(nodes) == 1 else And(nodes)

    def parse_factor(self) -> Node:
        tok = self.peek()
        if tok == "-":
            self.next()
            return Not(self.parse_factor())
        if tok == "(":
            self.next()
            node = self.parse_or()
            if self.peek() == ")":
                self.next()
            return node
        tok = self.next()
        if tok is not None and tok.startswith("-") and len(tok) > 1:
            return Not(Atom(tok[1:]))
        return Atom(tok or "")


def parse_query(query: str) -> Node:
    return _Parser(tokenize(query)).parse()


# ---------------------------------------------------------------------------
# Atom evaluation against the document
# ---------------------------------------------------------------------------

def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    return value


def _eval_atom(raw: str, doc: EmailDocument) -> bool:
    raw = raw.strip()
    if not raw:
        return True

    # operator:value  (but not a quoted phrase that merely contains a colon)
    if ":" in raw and not raw.startswith('"'):
        op, _, value = raw.partition(":")
        op = op.lower()
        value = _unquote(value).lower()

        if op == "has":
            return doc.has_attachments if value == "attachment" else False
        if op == "in":
            return False  # chats/anywhere not modeled -> not matched
        if op == "label":
            return False  # fresh inbound mail carries no gateway label yet
        if op == "from":
            return value in doc.from_addr.lower() or value in doc.from_name.lower()
        if op == "to":
            return any(value in a.lower() for a in doc.to_addrs)
        if op == "subject":
            return value in doc.subject.lower()
        if op == "filename":
            return any(_filename_match(value, a.filename) for a in doc.attachments)
        # unknown operator -> treat the whole thing as a bare word search
        return _word_match(raw.lower(), doc)

    # bare word / quoted phrase -> search subject + body + attachment names
    return _word_match(_unquote(raw).lower(), doc)


def _filename_match(value: str, filename: str) -> bool:
    name = filename.lower()
    if value in name:
        return True
    # `filename:pdf` should match by extension too
    return name.rsplit(".", 1)[-1] == value if "." in name else False


def _word_match(value: str, doc: EmailDocument) -> bool:
    if not value:
        return True
    haystack = f"{doc.subject}\n{doc.body_text}\n" + " ".join(a.filename for a in doc.attachments)
    return value in haystack.lower()


def query_matches(query: str, doc: EmailDocument) -> bool:
    """True if ``doc`` would match the Gmail ``query`` (compact or distributed form)."""
    return parse_query(expand_grouped_ops(query)).eval(doc)
