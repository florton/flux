# Flux Quick Reference

## Keywords (13)

`define` `with` `infer` `expect` `if` `elif` `else` `let` `return` `for` `in` `import` `error`

## Operators

**Logical:** `and` `or` `not` `is`

**Comparison:** `>` `<` `>=` `<=` `!=`

**Other:** `.` (field access), `=` (assignment)

## Types

**Basic:** `text` `number` `bool` `list` `null`

**Union:** `define priority as "low" or "medium" or "high"`

**Composite:**
```flux
define user as
  name text
  email text
  age number optional
```

**Nested lists:**
```flux
matrix list of list of number
```

## Literals

**Numbers:** `42`, `3.14`, `-10`

**Strings:** `"Hello"`, `'World'`

**Booleans:** `true`, `false`

**Lists:** `[1, 2, 3]`, `["a", "b", "c"]`, `[[1, 2], [3, 4]]`

**Objects:** `{ name: "Alice", age: 30 }`, `{ x: 1, y: { z: 2 } }`

**Nothing:** `null`

## Define Functions

**Explicit returns required:**
```flux
define greet with name
  let message = concat with "Hello ", name
  return message  # return keyword required

# Multiple values via object
define analyze with data
  let result = process with data
  return {
    data: result,
    timestamp: now,
    success: true
  }
```

## AI Inference

### Classification
```flux
let category = infer email
  expect "spam" or "inbox"
```

### Extraction
```flux
let invoice_data = infer pdf
  expect invoice
```

### Generation
```flux
let summary = infer article
  expect text
  prompt "create 2-3 sentence summary"
```

### Batch Processing
```flux
# Process each (default)
let items = infer photos
  expect receipt

# Batch 20 at a time
let results = infer items batch 20
  expect category

# All together
let results = infer items batch all
  expect category
```

### Complexity
```flux
complexity 1  # Fast/cheap models
complexity 2  # Balanced (default)
complexity 3  # Powerful/expensive
```

### Validation & Retry
```flux
let data = infer text
  expect user
  if result not has "email" retry 3
  if result not has required retry 2
```

### Resilience
```flux
let data = infer doc
  expect summary
  complexity 1
  fallback complexity 2      # Try better model if fails
  fallback return "default"  # Ultimate fallback
  circuit 5                  # Stop after 5 consecutive failures
  circuit_timeout 60         # Reset circuit after 60s
```

## Resilience Semantics

**Every LLM call counts toward circuit:**
- Each API call (including retries) = +1
- Success resets counter to 0
- After N consecutive failures, circuit opens
- When open: skip remaining calls, run error handler

**Example:**
```flux
for doc in documents  # 100 docs
  let data = infer doc
    circuit 5
    if result not has required retry 2

# Doc 1: Fail → Retry: Fail → Retry: Fail = 3 attempts, circuit: 3
# Doc 2: Fail → Retry: Fail = 2 attempts, circuit: 5 → Opens
# Docs 3-100: Skipped (saved 98 API calls)
```

## Control Flow

```flux
# Conditionals with comparison
if score >= 90
  return "excellent"
elif score >= 70
  return "good"
elif score >= 50
  return "average"
else
  return "poor"

# Multiple value check
if priority is "critical", "high"  # Shorthand for: priority is "critical" or priority is "high"
  escalate with ticket

# Boolean logic
if age >= 18 and verified is true
  grant_access with user
  
if stock <= 5 or discontinued is true
  alert_low_inventory with item

# Loops
let total = 0
for num in numbers
  if num > 0
    total = total + num

# Nested loops
for row in matrix
  for cell in row
    process with cell
    
# Continue (only valid inside for loops)
for item in items
  if item.invalid is true
    continue  # Skip to next item
  process with item
```

## Error Handling

```flux
# Return fallback
let content = read_file with path
  error return "not found"

# Continue in loop
for file in files
  let data = read_file with file
    error continue
```

## Field Access

```flux
user.email
user.contact.phone
items.0        # List index
matrix.0.0     # Nested list
```

## Validation

```flux
if data has "field1", "field2"  # Specific fields
if data has required             # All required fields
if data has all                  # Including optional
```

## Imports

```flux
import types
import types.invoice
import utils.validation
```

## Common Patterns

### Robust Extraction
```flux
define extract with pdf
  let text = read_file with pdf
    error return { error: "Read failed", file: pdf }
  
  let invoice_data = infer text
    expect invoice
    complexity 2
    fallback complexity 3
    circuit 10
    if result not has required retry 2
    error return { status: "needs_review", file: pdf }
  
  if invoice_data.total > 0
    return invoice_data
  else
    return { status: "invalid", data: invoice_data }
```

### Batch Classification with Resilience
```flux
define classify_batch with items
  let results = infer items batch 20
    expect category
    complexity 1
    circuit 5
    error return { results: [], error: "circuit_open" }
  
  let counts = { high: 0, medium: 0, low: 0 }
  for result in results
    if result.priority is "high"
      counts.high = counts.high + 1
    elif result.priority is "medium"
      counts.medium = counts.medium + 1
    else
      counts.low = counts.low + 1
  
  return counts
```

### Loop with Error Recovery
```flux
define process_all with files
  let results = []
  let error_files = []
  
  for file in files
    let data = process with file
      error
        error_files = append with error_files, file
        continue
    
    if data.valid is true and data.score >= 5
      results = append with results, data
  
  return {
    results: results,
    errors: error_files,
    success_rate: results.length / files.length
  }
```

## Comments

```flux
# This is a comment
let x = 5  # Inline comment
```

## Scope

- ✅ Parameters and local variables only
- ✅ Variable mutation allowed
- ❌ No global variables
- ❌ No closures
