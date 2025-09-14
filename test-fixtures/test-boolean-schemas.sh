#!/bin/bash

# Test script for boolean schema support

echo "Testing Boolean Schema Support in OpenAPI 3.1"
echo "============================================="
echo ""

# Build the project
echo "Building project..."
npm run build:ts > /dev/null 2>&1

# Test 1: Boolean schema test fixture
echo "Test 1: Boolean schema test fixture"
node dist/main.js -s test-fixtures/boolean-schema-test.json -n BooleanSchemaTestClient > /tmp/boolean-test-output.ts 2>&1
if [ $? -eq 0 ]; then
    echo "✅ SUCCESS: Generated $(wc -l < /tmp/boolean-test-output.ts) lines of code"
else
    echo "❌ FAILED"
    cat /tmp/boolean-test-output.ts | grep -A2 "ERROR"
    exit 1
fi

echo ""

# Test 2: S2 OpenAPI spec (real-world case)
echo "Test 2: S2 OpenAPI spec (real-world case)"
if [ -f /tmp/s2-openapi.json ]; then
    node dist/main.js -s /tmp/s2-openapi.json -n S2Client > /tmp/s2-test-output.ts 2>&1
    if [ $? -eq 0 ]; then
        echo "✅ SUCCESS: Generated $(wc -l < /tmp/s2-test-output.ts) lines of code"
    else
        echo "❌ FAILED"
        cat /tmp/s2-test-output.ts | grep -A2 "ERROR"
        exit 1
    fi
else
    echo "⚠️  SKIPPED: S2 spec not found at /tmp/s2-openapi.json"
fi

echo ""
echo "All tests passed! ✅"