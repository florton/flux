# Flux: A Minimalist Hybrid Language

## Philosophy

Flux is designed for the AI era. Instead of reinventing low-level operations, it provides:
- **AI as a first-class primitive**: Use `infer` for classification, extraction, and generation
- **Batteries-included standard library**: ~40 high-level utilities for validation, I/O, and data transformation
- **Minimal core syntax**: Only 13 keywords for control flow and AI integration
- **Natural language style**: Minimal punctuation, readable code
- **High-level orchestration**: Compose AI and standard library functions, don't rebuild basics
- **Robust error handling**: `error` clauses for graceful failure recovery
- **Explicit scope**: No globals or closures, all data passed as parameters

**Best for**: Document intelligence, content classification, natural language interfaces, multi-modal pipelines, intelligent automation, and conversational AI.

**Not for**: Low-level systems programming or real-time processing.

## Core Syntax

### Reserved Words (12 core keywords)

Flux uses 12 essential keywords:
- **`define`** - create a function or type
- **`with`** - declare parameters
- **`infer`** - invoke AI (classification, extraction, or generation)
- **`expect`** - constrain AI output structure
- **`if`** - conditional branching
- **`elif`** - else-if branching
- **`else`** - alternative branch
- **`let`** - variable binding with `=`
- **`return`** - return values
- **`for`** - iterate over lists
- **`in`** - used with `for` loops
- **`import`** - import types/functions from other files

**Additional keywords:**
- **`error`** - error handling

**Logical operators:**
- `and` - logical AND
- `or` - logical OR (also used in union types)
- `not` - logical NOT / negation
- `is` - equality check

**Comparison operators:**
- `>` - greater than
- `<` - less than
- `>=` - greater than or equal
- `<=` - less than or equal
- `!=` - not equal

**Additional modifiers:**
- `optional` - mark fields that can be missing
- `prompt` - provide instructions and parameters for generation mode
- `result` - refers to the inferred data within an `infer` block
- `has` - check field presence (specific fields, `required`, or `all`)
- `retry N` - retry logic for failed validations
- `batch N` / `batch all` - explicit batching (default: process each item)
- `complexity N` - numeric model selection (1=fast/cheap, 2=balanced, 3=powerful/expensive)
- `fallback` - specify fallback models or values for resilience
- `circuit N` - circuit breaker after N consecutive failures

**Syntax rules:**
- **Whitespace**: Only newlines are significant (block structure). Spaces are for readability only.
- **Comments**: Use `#` for single-line comments
- **Field access**: Use `.` to access object fields (e.g., `user.email`)
- **Indentation**: Required for block structure (2 or 4 spaces recommended)
- **Multiple value comparison**: `if x is "a", "b", "c"` is shorthand for `if x is "a" or x is "b" or x is "c"`
- **Literals**: JavaScript-style literals for all types (numbers, strings, booleans, arrays, objects)
- **Continue**: Only valid inside `for` loops (syntax error elsewhere)

Everything else (validation, data operations, I/O) is provided by the standard library.

### Literals and Construction

**Numbers:**
```
let x = 42
let pi = 3.14159
let negative = -10
```

**Strings:**
```
let name = "Alice"
let message = "Hello, world!"
let quote = 'Single quotes work too'
```

**Booleans:**
```
let active = true
let disabled = false
```

**Lists (JavaScript array syntax):**
```
let numbers = [1, 2, 3, 4, 5]
let names = ["Alice", "Bob", "Charlie"]
let empty = []
let mixed = [1, "text", true]  # Mixed types allowed
let nested = [[1, 2], [3, 4], [5, 6]]
```

**Objects (JavaScript object syntax):**
```
let user = {
  name: "Alice",
  email: "alice@example.com",
  age: 30
}

let config = {
  timeout: 5000,
  retries: 3,
  enabled: true
}

# Nested objects
let person = {
  name: "Bob",
  contact: {
    email: "bob@example.com",
    phone: "555-1234"
  },
  tags: ["admin", "developer"]
}
```

**Nothing/Null:**
```
let value = null
let optional_field = null

if data.field is null
  return "no value"
```

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

All functions must explicitly return values using the `return` keyword. There are no implicit returns.

```
define analyze_contract with contract_pdf
  let summary = infer contract_pdf
    expect
      key_terms list
      risk_level text
      parties list
      expiry_date text
  
  return summary  # Explicit return required
```

**Single return value:**
```
define get_total with invoice
  return invoice.total
```

**Multiple returns (returns object):**
```
define process_data with input
  let result = transform with input
  let metadata = { processed: true, timestamp: now }
  
  # Return object with multiple values
  return {
    result: result,
    metadata: metadata
  }
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
  let invoice_data = infer document
    expect invoice
  return invoice_data
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

### Variable Assignment and Mutation

Variables can be reassigned and mutated:

```
define calculate_sum with numbers
  let total = 0
  for num in numbers
    total = add with total, num  # Reassign total
  return total
```

**Mutable counters and accumulators:**
```
define count_by_type with items
  let type_a = 0
  let type_b = 0
  let type_c = 0
  
  for item in items
    if item.type is "a"
      type_a = type_a + 1
    elif item.type is "b"
      type_b = type_b + 1
    else
      type_c = type_c + 1
  
  return type_a, type_b, type_c
```

**Using comparison operators:**
```
define filter_high_value with items
  let high_value = []
  for item in items
    if item.price > 100
      high_value = append with high_value, item
  return high_value

define calculate_discount with price, quantity
  if quantity >= 10
    return price * 0.9
  elif quantity >= 5
    return price * 0.95
  else
    return price
```

**Updating lists:**
```
define process_batch with documents
  let results = []
  let error_count = 0
  
  for doc in documents
    let data = infer doc
      expect summary
      error
        error_count = error_count + 1
        continue  # Skip to next document
    
    results = append with results, data
  
  return results, error_count
```

**Modifying values in loops:**
```
define apply_discount with items
  for item in items
    if item.price > 100
      item.price = item.price * 0.9  # 10% discount
  return items
```

### Error Handling

Use `error` to handle failures gracefully:

```
define safe_read with filename
  let content = read_file with filename
    error return "File not found"
  return content
```

**With specific error handling:**
```
define process_invoice with pdf_path
  let text = read_file with pdf_path
    error return flag_error with "Cannot read file"
  
  let invoice_data = infer text
    expect invoice
    error return flag_error with "Inference failed"
  
  let saved = write_to_database with invoice_data
    error return flag_error with "Database write failed"
  
  return saved
```

**Error handling with fallback values:**
```
define get_config with key
  let value = query_database with "config", key
    error return default_config with key
  return value
```

### Resilience Patterns

Handle AI API failures gracefully with fallback models and circuit breakers:

**Fallback to alternative models:**
```
define extract_invoice with pdf_text
  let invoice_data = infer pdf_text
    expect invoice
    complexity 2
    fallback complexity 3  # Try more powerful model if first fails
    if result not has required retry 2
  return invoice_data
```

**Chain multiple fallback models:**
```
define classify_content with text
  # Try fast model first, fall back to better models if needed
  let category = infer text
    expect category
    complexity 1
    fallback complexity 2
    fallback complexity 3
    fallback return "unknown"  # Final fallback to default value
  return category
```

**Circuit breaker to prevent cascading failures:**
```
define process_batch with documents
  let results = []
  
  for doc in documents
    let summary = infer doc
      expect summary
      complexity 2
      circuit 5  # Stop calling API after 5 consecutive failures
      error
        results = append with results, flag_error with "API unavailable"
        continue
    results = append with results, summary
  
  return results
```

**Combined resilience pattern:**
```
define robust_extraction with document
  let data = infer document
    expect document_data
    complexity 2
    fallback complexity 3  # Try more powerful model
    fallback return partial_extract with document  # Use rule-based fallback
    circuit 10  # Circuit breaker after 10 failures
    if result not has required retry 3
  return data
```

**Circuit breaker with reset:**
```
# Circuit breaker automatically resets after timeout period
define safe_infer with text
  let result = infer text
    expect summary
    circuit 5  # Open circuit after 5 failures
    circuit_timeout 60  # Try again after 60 seconds
    error return cached_result with text
  return result
```

### Resilience Semantics

**How circuits and retries work together:**

**Every LLM call counts toward the circuit:**
- Individual call = 1 attempt
- Batch call = 1 attempt  
- Each retry = +1 attempt

**Circuit opens after N consecutive failures:**
```flux
circuit 5  # Opens after 5 failed API calls in a row
```

**Success resets the counter to zero:**
```flux
# Example with 10 documents
Doc 1: Fail → circuit: 1
Doc 2: Fail → circuit: 2
Doc 3: Success → circuit: 0 (reset)
Doc 4: Fail → circuit: 1
Doc 5-8: Fail → circuit: 5 → Circuit opens
Docs 9-10: Skipped (saves tokens)
```

**Retries count toward circuit:**
```flux
let data = infer doc
  circuit 5
  if result not has required retry 2
```

If validation fails, each retry is a new LLM call:
- Original call: circuit +1
- Retry 1: circuit +1
- Retry 2: circuit +1
- Total: 3 attempts for one document

**Purpose: Stop wasting tokens during failures**

When the circuit opens:
- No more LLM calls are made
- Your `error` handler runs instead
- Saves money when service is degraded

### Loops and Iteration

Use `for...in` to iterate over lists:

```
define process_documents with file_list
  let results = []
  for file in file_list
    let text = read_file with file
    let data = infer text
      expect summary
    results = append with results, data
  return results
```

**With filtering and continue:**
```
define extract_urgent_tickets with ticket_list
  let urgent = []
  for ticket in ticket_list
    if ticket.invalid is true
      continue  # Skip invalid tickets
    
    let priority = infer ticket
      expect priority
      error continue  # Skip if inference fails
    
    if priority is "critical", "high"
      urgent = append with urgent, ticket
  return urgent
```

**Note:** The `continue` keyword is only valid inside `for` loops. Using it outside a loop is a syntax error.

**Accumulation pattern:**
```
define calculate_total with invoice_list
  let total = 0
  for invoice in invoice_list
    if invoice has "amount" and invoice.amount > 0
      total = total + invoice.amount
  return total
```

**With comparison operators:**
```
define filter_urgent with tickets
  let urgent = []
  for ticket in tickets
    if ticket.priority_score >= 8
      urgent = append with urgent, ticket
  return urgent

define validate_age with age
  if age < 18
    return "minor"
  elif age >= 18 and age < 65
    return "adult"
  else
    return "senior"
```

### Boolean Logic

Combine conditions with `and`, `or`, `not`:

```
define validate_user with user_data
  if user_data has "email" and user_data has "name"
    return process_user with user_data
  else
    return flag_for_review with user_data
```

**Comparison operators:**
```
define check_age with user
  if user.age >= 18
    return "adult"
  elif user.age > 0
    return "minor"
  else
    return "invalid age"

define filter_expensive with products
  let expensive = []
  for product in products
    if product.price > 1000 and product.stock > 0
      expensive = append with expensive, product
  return expensive
```

**Complex conditions:**
```
define route_ticket with ticket
  let priority = ticket.priority
  let category = ticket.category
  
  # Multiple value comparison - shorthand syntax
  if priority is "critical", "high"
    if category is "security", "billing"
      return escalate with ticket
    else
      return schedule_urgent with ticket
  elif priority is "medium"
    return schedule_normal with ticket
  else
    return schedule_low with ticket
```

**Equivalent verbose syntax:**
```
# These are equivalent:
if priority is "critical", "high"
if priority is "critical" or priority is "high"

# Multiple values in one check
if status is "pending", "processing", "queued"
if status is "pending" or status is "processing" or status is "queued"
```

**Negation:**
```
define check_completeness with data
  if not data has required
    return flag_incomplete with data
  elif not data has all
    return flag_partial with data
  else
    return approve with data
```

**Comparison and equality:**
```
define categorize_score with score
  if score >= 90
    return "excellent"
  elif score >= 70
    return "good"
  elif score >= 50
    return "average"
  else
    return "poor"

define check_status with count
  if count is 0
    return "empty"
  elif count > 0 and count <= 10
    return "few"
  else
    return "many"
```

### Modules and Imports

Organize code across multiple files:

**types.flux:**
```
define invoice as
  invoice_number text
  vendor text
  total number
  date text optional

define priority as "low" or "medium" or "high" or "critical"
```

**main.flux:**
```
import types

define process_invoice with pdf_path
  let text = read_file with pdf_path
  let invoice_data = infer text
    expect types.invoice
  return invoice_data

define classify_urgency with ticket_text
  let level = infer ticket_text
    expect types.priority
  return level
```

**With selective imports:**
```
import types.invoice
import types.priority
import utils.validation

define process with data
  let invoice_data = infer data
    expect invoice
  let validated = validation.check with invoice_data
  return validated
```

### Scope Rules

- **No global variables**: All data must be passed as parameters
- **No closure access**: Functions cannot access outer scope variables
- **Pure functions**: Functions only access their parameters and call other functions

```
# This is NOT allowed:
define outer with x
  let y = 10
  define inner with z
    return add with y, z  # ERROR: cannot access y
  return inner with 5

# Instead, pass explicitly:
define outer with x
  let y = 10
  define inner with y_val, z
    return add with y_val, z
  return inner with y, 5
```

## Standard Library

Flux provides high-level utilities organized by category. All functions use `with` for parameters.

### Validation Functions

**`validate_schema with data, schema`**
- Validates data against a schema
- Returns validated data or error

**`validate_range with value, min, max`**
- Checks if numeric value is within range
- Returns value or error

**`validate_format with text, pattern`**
- Validates text against regex pattern
- Returns text or error

**`validate_email with text`**
- Validates email format
- Returns text or error

### Data Transformation

**`transform_data with data, operation`**
- Applies transformation operation to data
- Operations: "count by field", "group by field", "sum field", "average field"

**`extract_field with data, field_name`**
- Extracts specific field from object
- Returns field value

**`merge_records with data1, data2`**
- Merges two objects
- Returns combined object

**`deduplicate with list`**
- Removes duplicate items
- Returns unique list

**`filter with list, condition`**
- Filters list by condition
- Returns filtered list

**`map with list, function`**
- Applies function to each item
- Returns transformed list

**`sort with list, field`**
- Sorts list by field
- Returns sorted list

**`append with list, item`**
- Adds item to list
- Returns new list

### Math Operations

**`add with a, b`**
- Addition

**`subtract with a, b`**
- Subtraction

**`multiply with a, b`**
- Multiplication

**`divide with a, b`**
- Division (returns error on divide by zero)

**`round with number, decimals`**
- Rounds to specified decimals

### I/O Functions

**`read_file with path`**
- Reads file contents
- Returns text or error via `error`

**`write_file with path, content`**
- Writes content to file
- Returns success or error

**`query_database with table, filters`**
- Queries database table
- Returns results or error

**`write_to_database with table, data`**
- Writes data to database
- Returns success or error

**`call_api with url, method, payload`**
- Makes HTTP API call
- Returns response or error

**`send_email with recipient, subject, body`**
- Sends email
- Returns success or error

### String Operations

**`concat with text1, text2`**
- Concatenates strings

**`split with text, delimiter`**
- Splits text into list

**`replace with text, old, new`**
- Replaces substring

**`lowercase with text`**
- Converts to lowercase

**`uppercase with text`**
- Converts to uppercase

**`trim with text`**
- Removes whitespace

### Utility Functions

**`flag_for_review with data`**
- Marks data for human review
- Returns flagged data object

**`flag_error with message`**
- Creates error object with message
- Returns error object

**`default_config with key`**
- Returns default configuration value
- Returns config value

**`log with message`**
- Logs message (debugging)
- Returns null

Example usage:
```
define process_document with pdf_file
  let text = read_file with pdf_file
    error return flag_error with "Cannot read file"
  
  let data = infer text
    expect
      title text
      authors list
  
  let validated = validate_schema with data
    error return flag_for_review with data
  
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
let invoice_data = infer text
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
- `text` - string values
- `number` - numeric values
- `bool` - boolean true/false
- `list` - lists (can be nested)
- `null` - null/none value

### List Types
```
# Simple list
emails list of text

# Nested list (2D array)
matrix list of list of number

# List of lists of objects
spreadsheet list of list of cell

# Complex nesting
data list of list of list of text
```

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

### List Handling

**Nested lists are supported:**
```
# Simple lists:
define user as
  name text
  emails list of text

# Nested lists:
define matrix as
  rows list of list of number

# Lists of lists of objects:
define spreadsheet as
  sheets list of sheet

define sheet as
  rows list of list of cell

define cell as
  value text
  formula text optional
```

**Usage:**
```
# Create nested structure
let data = infer csv_file
  expect matrix

# Access nested data:
let first_row = data.rows.0
let first_cell = first_row.0

# Iterate over nested lists:
for row in data.rows
  for cell in row
    let processed = validate with cell
```

**Lists of objects:**
```
define invoice_item as
  description text
  quantity number
  price number

define invoice as
  invoice_number text
  items list of invoice_item
  total number
```

### Field Access

Use dot notation (`.`) to access nested fields:

```
define contact as
  name text
  email text
  phone text optional

define user as
  username text
  contact_info contact
  active bool

define get_email with user_data
  # Access nested fields with dot notation
  let email = user_data.contact_info.email
  return email

# Check nested fields
if user_data.contact_info has "email"
  let email = user_data.contact_info.email
  return send_email with email, "Welcome!"
else
  return flag_for_review with user_data
```

**Accessing list elements:**
```
define get_first_item with invoice
  # Access by index (0-based)
  let first = invoice.items.0
  return first.description
```

### Validation and Error Handling

Flux always accepts partial data from AI inference. Use `result` within `infer` blocks for retry logic:

```
define parse_user_form with form_text
  let user_data = infer form_text
    expect user
    if result not has "email", "name" retry 3
  
  if user_data has "email", "name"
    return process_user with user_data
  else
    return flag_for_review with user_data
```

**Retry patterns:**

1. **Retry for specific fields:**
```
let invoice_data = infer text
  expect invoice
  if result not has "total", "invoice_number" retry 2

if invoice_data has "total", "invoice_number"
  return invoice_data
else
  return flag_for_review with invoice_data
```

2. **Retry until all required fields present:**
```
let user_data = infer form_text
  expect user
  if result not has required retry 3

if user_data has required
  return save_user with user_data
else
  return flag_for_review with user_data
```

3. **Accept degraded quality after retries:**
```
let invoice_data = infer text
  expect invoice
  if result not has "total", "invoice_number", "vendor" retry 2

# After retries, accept minimum
if invoice_data has "total", "invoice_number"
  return invoice_data
else
  return flag_for_review with invoice_data
```

## Real-World Examples

### Invoice Processing with Resilience
```
define invoice as
  invoice_number text
  vendor text
  total number
  date text optional

define extract_invoice with invoice_pdf
  let text = read_file with invoice_pdf
    error return { error: "Cannot read PDF", file: invoice_pdf }
  
  let invoice_data = infer text
    expect invoice
    complexity 2
    fallback complexity 3
    circuit 5
    if result not has "total", "invoice_number" retry 2
    error return { status: "needs_review", file: invoice_pdf }
  
  if invoice_data has required and invoice_data.total > 0
    return write_to_database with "invoices", invoice_data
  else
    return { status: "needs_review", invoice: invoice_data }
```

### Batch Processing with Circuit Breaker
```
define sentiment as "positive" or "negative" or "neutral"

define analyze_feedback with review_list
  let sentiments = infer review_list batch 20
    expect sentiment
    complexity 1
    circuit 5
    if result not has required retry 2
  
  let positive_count = 0
  let negative_count = 0
  let neutral_count = 0
  
  for sentiment in sentiments
    if sentiment is "positive"
      positive_count = positive_count + 1
    elif sentiment is "negative"
      negative_count = negative_count + 1
    else
      neutral_count = neutral_count + 1
  
  return {
    positive: positive_count,
    negative: negative_count,
    neutral: neutral_count,
    total: sentiments.length
  }
```

### Multi-File Processing
```
import types

define process_batch with pdf_paths
  let results = []
  let errors = []
  
  for path in pdf_paths
    let text = read_file with path
      error
        errors = append with errors, { file: path, error: "read_failed" }
        continue
    
    let invoice_data = infer text
      expect types.invoice
      complexity 2
      fallback complexity 3
      circuit 10
      if result not has required retry 2
      error
        errors = append with errors, { file: path, error: "inference_failed" }
        continue
    
    if invoice_data has required and invoice_data.total > 0
      results = append with results, invoice_data
  
  return { results: results, errors: errors, processed: pdf_paths.length }
```

### Nested List Processing
```
define cell as
  value text
  type text

define process_spreadsheet with csv_file
  let data = infer csv_file
    expect list of list of cell
    complexity 2
    fallback complexity 3
    circuit 5
  
  let totals = []
  for row in data
    let row_sum = 0
    for cell in row
      if cell.type is "number"
        let num = parse_number with cell.value
        if num != null
          row_sum = row_sum + num
    totals = append with totals, row_sum
  
  return { row_totals: totals, row_count: data.length }
```

## Implementation Strategy

1. **Parser**: Newline-sensitive parser for 13 keywords + standard library calls
2. **Type System**: Basic types, composite types, union types, nested lists
3. **Standard Library**: ~40 high-level utility functions
4. **AI Integration**: LLM API connectors with prompt generation from `infer` blocks
5. **Compiler**: Transpile to TypeScript with async/await for AI calls
6. **Runtime**: Execute code, handle retries, fallbacks, and circuit breakers

## Key Innovations

1. **Unified AI Primitive**: `infer` handles classification, extraction, and generation
2. **Type-Safe AI Output**: Define schemas once, reference everywhere
3. **Built-in Resilience**: Circuit breakers and fallback chains prevent token waste
4. **Cost Awareness**: Batching, complexity controls, early-break on failures
5. **Graceful Degradation**: Accept partial data, handle errors naturally
6. **Nested Lists**: Full support for complex data structures
7. **Simple Syntax**: 13 keywords, natural language style

## Design Principles

1. **High-level abstraction** - describe what, not how
2. **AI-first** - complex reasoning → `infer`
3. **Batteries included** - standard library for common tasks
4. **Explicit scope** - no globals or closures
5. **Cost control** - batching, complexity, circuits built-in
6. **Production ready** - error handling, resilience, validation

## Language Constraints

- ✅ Nested lists supported
- ✅ Variable mutation allowed
- ❌ No closures (functions cannot capture outer scope)
- ❌ No global state (all data passed explicitly)
- ❌ No multi-value returns (return object instead)
