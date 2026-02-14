# Flux: A Minimalist Hybrid Language

## Philosophy

Flux is designed for the AI era. Instead of reinventing low-level operations, it provides:
- **AI as a first-class primitive**: Use `infer` for classification, extraction, and generation
- **Batteries-included standard library**: High-level utilities for validation, I/O, and data transformation
- **Minimal core syntax**: Only 8 reserved words for maximum clarity
- **Natural language style**: Zero brackets, parentheses, colons or semicolons
- **High-level orchestration**: Compose AI and standard library functions, don't rebuild basics

**Best for**: Document intelligence, content classification, natural language interfaces, multi-modal pipelines, intelligent automation, and conversational AI.

## Core Syntax

### Reserved Words (8 core keywords)

Flux uses only 8 essential keywords:
- **`define`** - create a function or type
- **`with`** - declare parameters
- **`infer`** - invoke AI (classification, extraction, or generation)
- **`expect`** - constrain AI output structure
- **`if`** - conditional branching
- **`else`** - alternative branch
- **`let`** - variable binding with `=`
- **`return`** - return values

**Additional modifiers (8 total):**
- `optional` - mark fields that can be missing
- `prompt` - provide instructions and parameters for generation mode (tone, style, format, etc.)
- `result` - refers to the inferred data within an `infer` block
- `has` - check field presence with three modes:
  - `has "field1", "field2"` - check specific fields
  - `has required` - check all required fields
  - `has all` - check all fields including optional
- `not` - negate conditions
- `retry N` - retry logic for failed validations
- `batch N` / `batch all` - explicit batching (default: process each item)
- `complexity N` - numeric model selection (1=fast/cheap, 2=balanced, 3=powerful/expensive)

Everything else (validation, data operations, I/O) is provided by the standard library.

### Data Type Definitions

Define reusable structures for use in `expect`:

```
define priority as "low" or "medium" or "high" or "critical"
define sentiment as "positive" or "negative" or "neutral"

define user as
  name text
  email text
  phone text optional

define invoice as
  invoice_number text
  vendor text
  total number
  date text optional
```

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

### Function Examples

**Classification:**
```
define sentiment as "positive" or "negative" or "neutral"

define analyze_sentiment with review_text
  let emotion = infer review_text
    expect sentiment
  return emotion
```

**Extraction:**
```
define invoice as
  invoice_number text
  vendor text
  total number

define extract_invoice with document
  let data = infer document
    expect invoice
  return data
```

**Generation:**
```
define create_summary with article_text
  let summary = infer article_text
    expect text
    prompt "create a 2-3 sentence summary"
    style "concise"
  return summary
```

**Conditional Logic:**
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

`infer` adapts based on what you `expect` - classification, extraction, or generation.

### Classification Mode - Union Types

Use union types to classify into predefined categories:

```
define category as "spam" or "inbox" or "important"

define categorize_email with email_body
  let result = infer email_body
    expect category
  return result
```

```
define sentiment as "positive" or "negative" or "neutral"
define urgency as "low" or "medium" or "high" or "critical"

define classify_feedback with customer_feedback
  let emotion = infer customer_feedback
    expect sentiment
  let priority = infer customer_feedback
    expect urgency
  return emotion, priority
```

### Extraction Mode - Structured Types

Use structured types to extract data:

```
define receipt_item as
  description text
  amount number
  category text optional

define extract_receipt with photo
  let items = infer photo
    expect list of receipt_item
  return items
```

### Generation Mode - Text with Instructions

Use `expect text` with `prompt` to generate content:

```
define summarize_article with article_text
  let summary = infer article_text
    expect text
    prompt "create a concise summary in 2-3 sentences"
    max_length 200
  return summary
```

```
define write_response with customer_email
  let response = infer customer_email
    expect text
    prompt "write a professional, empathetic response that apologizes and offers a solution"
    tone "friendly"
  return response
```

### Combining Multiple Inputs for Generation

Pass multiple data sources to guide generation:

```
define create_insights with sales_data, trends_data, goals
  let report = infer sales_data, trends_data, goals
    expect text
    prompt "analyze sales against trends and goals, provide actionable insights"
    format "executive summary with bullet points"
    sections "overview, analysis, recommendations"
  return report
```

### List Processing & Complexity

**Default: Process each item individually (most accurate):**
```
define receipt_item as
  description text
  amount number

define process_receipts with photo_list
  # Default behavior - processes each item
  let items = infer photo_list
    expect receipt_item
    complexity 2
  return items
```

**Process in batches (balanced accuracy and cost):**
```
define sentiment as "positive" or "negative" or "neutral"

define classify_reviews with review_list
  # Process 20 at a time - good for simple tasks
  let sentiments = infer review_list batch 20
    expect sentiment
    complexity 1
  return sentiments
```

**Process all together (fastest, cheapest, lower accuracy):**
```
define quick_classify with short_text_list
  # Process entire list in one call
  let categories = infer short_text_list batch all
    expect list of category
    complexity 1
  return categories
```

**Complexity examples:**
```
# Complexity 1 - fast models for classification/simple extraction
let category = infer email_body
  expect category
  complexity 1

# Complexity 2 (default) - balanced models for structured extraction
let invoice = infer text
  expect invoice
  # complexity 2 is default, can be omitted

# Complexity 3 - powerful models for analysis/reasoning
let analysis = infer contract_pdf, market_data
  expect text
  prompt "provide comprehensive strategic analysis"
  complexity 3
```

**Design Philosophy for List Processing:**

1. **Default (no modifier)** - One LLM call per item
   - Maximum accuracy for complex tasks
   - Best for: document extraction, image analysis, complex classification
   - Cost: Highest (N calls for N items)

2. **`batch N`** - Process N items per call
   - Balances accuracy and cost
   - Best for: moderate classification, sentiment analysis
   - Cost: Medium (N/batch_size calls)

3. **`batch all`** - All items in one call
   - Fastest and cheapest
   - Best for: simple classification of short texts
   - Cost: Lowest (1 call total)
   - Risk: Lower accuracy, context window limits

**Complexity scale (1-3):**
- **`1`**: Fast, cheap models (gpt-3.5-turbo, claude-haiku)
- **`2`**: Balanced models (gpt-4o-mini, claude-sonnet) - default
- **`3`**: Powerful models (gpt-4o, claude-opus)

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

// Batch processing example
async function classifyEmails(emails: string[]): Promise<string[]> {
  const categories = await llm.inferBatch({
    inputs: emails,
    batchSize: 20,
    schema: { type: "enum", values: ["spam", "inbox", "important"] },
    complexity: 1,
    retryCondition: (result) => result.hasRequired(),
    maxRetries: 2
  });
  return categories;
}

// Default individual processing (no batch specified)
async function processReceipts(photos: Image[]): Promise<ReceiptItem[]> {
  const items = await Promise.all(
    photos.map(photo => 
      llm.infer({
        input: photo,
        schema: ReceiptItemSchema,
        complexity: 2,
        retryCondition: (result) => 
          result.has("description", "amount"),
        maxRetries: 2
      })
    )
  );
  return items;
}

// Batch all processing
async function quickClassify(texts: string[]): Promise<string[]> {
  const categories = await llm.infer({
    input: texts,
    batchSize: "all",
    schema: { type: "array", items: { type: "enum", values: ["a", "b", "c"] } },
    complexity: 1
  });
  return categories;
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
Define reusable schemas with optional fields for partial data:

```
define address as
  street text
  city text
  zip text optional

define user as
  name text
  email text
  phone text optional
  address address optional
```

Fields marked `optional` allow partial extraction when AI can't find all data.

### Union Types
```
define status as "pending" or "complete" or "failed"
define priority as "low" or "medium" or "high" or "critical"
```

### Validation and Error Handling

Flux always accepts partial data from AI inference. Use `result` within `infer` blocks for retry logic:

```
define parse_user_form with form_text
  let user = infer form_text
    expect user
    if result not has "email", "name" retry 3
  
  if user has "email", "name"
    return process_user with user
  else
    return flag_for_review with user
```

**Retry patterns:**

1. **Retry for specific fields:**
```
let invoice = infer text
  expect invoice
  if result not has "total", "invoice_number" retry 2

if invoice has "total", "invoice_number"
  return invoice
else
  return flag_for_review with invoice
```

2. **Retry until all required fields present:**
```
let user = infer form_text
  expect user
  if result not has required retry 3

if user has required
  return save_user with user
else
  return flag_for_review with user
```

3. **Accept degraded quality after retries:**
```
let invoice = infer text
  expect invoice
  if result not has "total", "invoice_number", "vendor" retry 2

# After retries, accept minimum
if invoice has "total", "invoice_number"
  return invoice
else
  return flag_for_review with invoice
```

## Real-World Examples

### Invoice Processing with Typed Schema
```
define line_item as
  description text
  quantity number optional
  price number

define invoice as
  invoice_number text
  vendor text
  line_items list of line_item
  total number
  date text optional

define extract_invoice with invoice_pdf
  let text = read_file with invoice_pdf
  let invoice = infer text
    expect invoice
  
  # Smart retry - only if critical fields missing
  if invoice has "total", "invoice_number", "vendor"
    # Has critical fields - proceed
    let validated = validate_schema with invoice
    return validated
  else
    # Missing critical fields - retry once
    let invoice = infer text
      expect invoice
    
    if invoice has "total", "invoice_number"
      # At minimum we have these
      return invoice
    else
      # Still incomplete
      return flag_for_review with invoice
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

### Content Generation with Data
```
define sales_report as
  revenue number
  top_products list of text
  growth_rate number

define create_summary_email with sales_data
  # Extract key metrics
  let report = infer sales_data
    expect sales_report
  
  if report has required
    # Generate executive summary from extracted data
    let email_body = infer report
      expect text
      prompt "create an executive summary email highlighting revenue, top products, and growth"
      tone "professional but optimistic"
      format "short paragraphs with key takeaways"
    
    return email_body
  else
    return flag_for_review with report
```

### Multi-Input Analysis
```
define analyze_campaign with campaign_data, competitor_data, market_trends
  let analysis = infer campaign_data, competitor_data, market_trends
    expect text
    prompt "analyze campaign performance against competitors and market trends"
    sections "performance summary, competitive position, recommendations"
    style "data-driven with specific insights"
    complexity 3
  
  return analysis
```

### Batch Processing with Cost Optimization
```
define sentiment as "positive" or "negative" or "neutral"

define analyze_customer_feedback with feedback_list
  # Classify hundreds of reviews efficiently
  let sentiments = infer feedback_list batch 20
    expect sentiment
    complexity 1
    if result not has required retry 2
  
  # Aggregate results with standard library
  let summary = transform_data with sentiments, "count by sentiment"
  
  # Generate insights from aggregated data
  let insights = infer summary
    expect text
    prompt "analyze sentiment patterns and provide actionable insights"
    complexity 3
  
  return insights
```

### Individual Processing for Accuracy
```
define receipt_item as
  description text
  amount number
  category text

define process_expense_receipts with photo_list
  # Process each receipt photo individually (default behavior)
  let items = infer photo_list
    expect receipt_item
    complexity 2
    if result not has "description", "amount" retry 2
  
  # Generate expense report from all items
  let report = infer items
    expect text
    prompt "create expense report summary with totals by category"
    format "professional business format"
    complexity 1
  
  return report
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

1. **Unified AI Primitive**: `infer` handles classification, extraction, and generation based on `expect`
2. **Type-Safe AI Output**: Define schemas once, reference in `expect` everywhere
3. **Consolidated Validation**: Single `has` operator with three modes (specific fields, `required`, `all`)
4. **Smart Retry Control**: User decides when to retry based on `has` checks
5. **Always Returns Data**: Even incomplete extractions are useful
6. **Default Individual Processing**: Lists processed item-by-item unless batching specified
7. **Numeric Complexity Scale**: Simple 1-3 scale for model selection (1=fast, 2=balanced, 3=powerful)
8. **Minimal Syntax**: Only 8 keywords + 8 modifiers - everything else is standard library

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
