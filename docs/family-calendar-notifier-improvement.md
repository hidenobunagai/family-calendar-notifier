# Improvement Proposal: Add Configuration Validation

## Current State
The family-calendar-notifier project lacks robust configuration validation at startup.

## Proposed Change
Add a `validateSetup()` function that checks:
1. All required properties are set
2. Calendar ID format is valid
3. Discord webhook URL is valid
4. LINE credentials are present if enabled

## Benefits
- Prevents runtime errors from missing configuration
- Provides clear error messages for setup issues
- Improves reliability and user experience

## Implementation
1. Add validation logic in gas/Utils.gs
2. Call validateSetup() at the beginning of main handler
3. Add logging for validation failures

## Status
✅ Implemented
