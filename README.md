# Flux Programming Language

A minimalist language for AI orchestration and document intelligence.

## Files

- **[LANGUAGE_DESIGN.md](LANGUAGE_DESIGN.md)** - Complete language specification
- **[QUICK_REFERENCE.md](QUICK_REFERENCE.md)** - Quick syntax reference for developers

## Overview

Flux is designed for building AI-powered applications with:
- AI as a first-class primitive (`infer` keyword)
- Built-in resilience (circuit breakers, fallbacks)
- Type-safe AI outputs
- Cost awareness (batching, complexity controls)
- Production-ready error handling

## Quick Example

```flux
define invoice as
  invoice_number text
  vendor text
  total number

define extract_invoice with pdf_path
  let text = read_file with pdf_path
    error return { error: "Cannot read file", file: pdf_path }
  
  let invoice = infer text
    expect invoice
    complexity 2
    fallback complexity 3
    circuit 5
    if result not has required retry 2
    error return { status: "needs_review", file: pdf_path }
  
  if invoice.total > 0
    return invoice
  else
    return { status: "invalid", invoice: invoice }
```

## Best For

- Document intelligence pipelines
- Content classification at scale
- Intelligent customer service routing
- Data extraction from unstructured sources
- Multi-modal content processing

## Philosophy

- **13 keywords** - Minimal syntax, maximum clarity
- **AI-first design** - LLMs are first-class primitives
- **Batteries included** - ~40 stdlib functions
- **Cost aware** - Explicit batching and complexity controls
- **Production ready** - Circuit breakers, fallbacks, graceful degradation

## Status

Language design phase. See LANGUAGE_DESIGN.md for complete specification.
