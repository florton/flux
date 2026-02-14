# Flux: A Minimalist Hybrid Language

## Philosophy

Flux is designed for the AI era. Instead of reinventing low-level operations, it provides:
- **AI as a first-class primitive**: Use LLMs for complex reasoning, extraction, and classification
- **Batteries-included standard library**: High-level utilities for validation, I/O, and data transformation
- **Minimal core syntax**: Only 8 reserved words for maximum clarity
- **Natural language style**: Zero brackets, parentheses, colons or semicolons
- **High-level orchestration**: Compose AI and standard library functions, don't rebuild basics

**Best for**: Document intelligence, natural language interfaces, content classification, multi-modal pipelines, and intelligent automation.

## Core Syntax

### Reserved Words (8 core keywords)

Flux uses only 8 essential keywords:
- **`define`** - create a function
- **`with`** - declare parameters
- **`infer`** - invoke AI inference (the key primitive)
- **`expect`** - constrain AI output structure
- **`if`** - conditional branching
- **`else`** - alternative branch
- **`let`** - variable binding with `=`
- **`return`** - return values

Everything else (validation, data operations, I/O) is provided by the standard library.

### Function Definition

```
define analyze_contract with contract_pdf
  let summary = infer contract_pdf
    expect
      key_terms list
      risk_level text
      parties list
      expiry_date text
  
  return summary
```

### AI Inference: The Core Primitive

The `infer` keyword delegates complex tasks to AI with structured constraints:

```
define categorize_email with email_body
  let category = infer email_body
    expect "spam" or "inbox" or "important"
  
  return category
```

### Conditional Logic

```
define process_order with email_text
  let order = infer email_text
    expect
      customer text
      items list
      urgent bool
  
  if order.urgent
    return notify_warehouse with order
  else
    return schedule_delivery with order
```

### Data Structures

Define reusable data structures that can be referenced in `expect` blocks:

```
define invoice as
  invoice_number text
  vendor text
  line_items list of
    description text
    quantity number
    price number
  total number

define priority as "low" or "medium" or "high" or "critical"
```

These structures are used in `expect` to ensure consistent AI outputs:

```
define extract_invoice with text
  let result = infer text
    expect invoice
  return result

define classify_ticket with ticket_text
  let urgency = infer ticket_text
    expect priority
  return urgency
```

## Standard Library

Flux provides high-level utilities in these categories:
- **Validation**: `validate_schema`, `validate_range`, `validate_format`
- **Data**: `transform_data`, `extract_field`, `merge_records`, `deduplicate`
- **I/O**: `query_database`, `send_email`, `call_api`, `read_file`, `write_file`
- **AI Utilities**: `classify`, `extract`, `summarize`, `translate`, `generate`

Example usage:
```
define process_document with pdf_file
  let text = read_file with pdf_file
  let data = infer text
    expect
      title text
      authors list
  let validated = validate_schema with data
  return validated
```

## AI Inference in Depth

## AI Inference in Depth

The `infer` keyword delegates complex tasks to AI with structured output constraints. Types can be defined once and reused across all `infer` blocks.

### Simple Union Types
```
define category as "spam" or "inbox" or "important"

define categorize_email with email_body
  let result = infer email_body
    expect category
  return result
```

### Complex Structured Types
```
define receipt_item as
  description text
  amount number
  category text

define extract_receipt with photo
  let items = infer photo
    expect list of receipt_item
  return items
```

This pattern enables:
- **Type reuse** across multiple functions
- **Consistent schemas** for LLM prompts
- **Compile-time validation** of expected structures
- **Self-documenting code** with explicit data contracts

## Compilation Targets

### Mode 1: Transpile to TypeScript

User code → TypeScript functions
`infer` blocks → LLM API calls
Standard library → imported utilities

```typescript
// Generated from Flux
async function interpretCommand(userInput: string): Promise<string> {
  const intent = await llm.infer({
    input: userInput,
    schema: {
      type: "enum",
      values: ["search", "create", "delete", "help"]
    }
  });
  return intent;
}
```

### Mode 2: Compile to AI Prompt

Entire program becomes a structured prompt for execution by LLM:

```
You are executing a Flux program.

Function: interpret_command
Input: "show me all users from last week"

Task: Infer the command intent from the input.

Constraints:
- Must be one of: "search", "create", "delete", "help"

Respond with valid JSON: {"intent": "..."}
```

## Type System

### Basic Types
- `text`, `number`, `bool`, `list`, `nothing`

### Composite Types
Define reusable schemas that `expect` can reference:

```
define address as
  street text
  city text
  zip text

define user as
  name text
  email text
  address address
```

### Union Types
```
define status as "pending" or "complete" or "failed"
define priority as "low" or "medium" or "high" or "critical"
```

### Using Types with AI Inference
Reference types in `expect` for consistent, validated outputs:

```
define parse_user_form with form_text
  let user_data = infer form_text
    expect user
  return user_data
```

This generates structured LLM prompts with the exact schema, ensuring type-safe AI outputs.

## Real-World Examples

### Invoice Processing with Typed Schema
```
define line_item as
  description text
  quantity number
  price number

define invoice as
  invoice_number text
  vendor text
  line_items list of line_item
  total number

define extract_invoice with invoice_pdf
  let text = read_file with invoice_pdf
  let invoice_data = infer text
    expect invoice
  let validated = validate_schema with invoice_data
  return validated
```

### Multi-Step AI Pipeline with Types
```
define priority as "low" or "medium" or "high" or "critical"
define category as "billing" or "technical" or "general"

define team_info as
  name text
  email text
  specialty category

define route_support_ticket with ticket_text
  let urgency = infer ticket_text
    expect priority
  let ticket_category = infer ticket_text
    expect category
  let team = query_database with "teams", urgency, ticket_category
  let assigned = send_email with team.email, ticket_text
  return assigned
```

### Conditional Logic with Typed AI Output
```
define order as
  customer text
  items list
  urgent bool

define process_order_email with email_text
  let order_data = infer email_text
    expect order
  if order_data.urgent
    return send_email with "warehouse@company.com", order_data
  else
    return call_api with "schedule_delivery", order_data
```

## Execution Examples

### Example 1: Email Categorization

**Code:**
```
define categorize_email with email_body
  let category = infer email_body
    expect "spam" or "inbox" or "important"
  return category
```

**Execution with input** `"You've won $1,000,000! Click here now!!!"`

**AI Prompt Generated:**
```
You are a Flux language runtime executing an AI inference task.

Function: categorize_email
Input: "You've won $1,000,000! Click here now!!!"

Task: Infer classification from the email body.
Constraints: Must be one of "spam", "inbox", "important"

Respond with valid JSON:
{"result": "spam" | "inbox" | "important", "confidence": 0.0-1.0}
```

**LLM Response:**
```json
{"result": "spam", "confidence": 0.98}
```

**Output:** `"spam"`

---

### Example 2: Invoice Processing Pipeline

**Code:**
```
define line_item as
  description text
  quantity number
  price number

define invoice as
  invoice_number text
  vendor text
  line_items list of line_item
  total number

define extract_invoice with invoice_pdf
  let text = read_file with invoice_pdf
  let invoice_data = infer text
    expect invoice
  let validated = validate_schema with invoice_data
  return validated
```

**Execution Steps:**
1. `read_file` → Returns invoice text from PDF
2. `infer text` → Calls LLM with `invoice` schema constraints
3. LLM returns structured data matching `invoice` type
4. `validate_schema` → Checks structure ✓
5. Returns validated invoice data

**AI Prompt Generated (Step 2):**
```
Function: extract_invoice
Input: "INVOICE\nInvoice #12345\n..."

Expected Schema (from 'invoice' type):
{
  "invoice_number": "text",
  "vendor": "text", 
  "line_items": [{
    "description": "text",
    "quantity": "number",
    "price": "number"
  }],
  "total": "number"
}

Extract structured invoice information from the text.
Respond with valid JSON matching the schema.
```

**Benefits of Type Reference:**
- Schema defined once, used everywhere
- LLM prompt generation automatic
- Type safety across all invoice operations
- Easy to extend (add fields to `invoice` type, all usages update)

## Implementation Strategy

### Phases
1. **Parser**: Whitespace-sensitive parser for 8 keywords + standard library calls
2. **Standard Library**: High-level utilities (validation, I/O, data transformation)
3. **AI Integration**: LLM API connectors with prompt generation from `infer` blocks
4. **Compiler**: Transpile to TypeScript with async/await for AI calls
5. **Runtime**: Execute code, route `infer` to LLM APIs, handle retries

## Key Innovations

1. **AI as First-Class Primitive**: `infer` makes LLM calls feel native
2. **Type-Safe AI Output**: Define schemas once, reference in `expect` everywhere
3. **Minimal Syntax**: Only 8 keywords - everything else is standard library
4. **Batteries Included**: Users orchestrate, not implement
5. **Dual Compilation**: Transpile to TypeScript OR compile to AI prompts
6. **Reusable Type System**: Types become LLM schema constraints automatically

## Design Principles

1. High-level abstraction - describe what, not how
2. Delegate to AI liberally - complex reasoning → `infer`
3. Standard library for common tasks - don't rebuild basics
4. Minimal syntax - fewer keywords = easier to learn
5. Explicit AI boundaries - `infer` blocks clearly marked

## Next Steps

1. Build parser for 8 core keywords
2. Create standard library stubs
3. Implement TypeScript transpiler
4. Connect `infer` to OpenAI/Anthropic APIs
5. Test with document processing use cases
