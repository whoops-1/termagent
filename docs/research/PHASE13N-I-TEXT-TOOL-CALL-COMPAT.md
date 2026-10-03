# Phase 13N-I — Text-Encoded Tool Call Compatibility

## Problem

A live Termux trace showed a provider returning a tool request as ordinary assistant text instead of a structured `tool_call` event. The visible response contained the following shape:

```text
<tool_call>
<function=read_file>
<parameter=path>
…
</parameter>
</function>
</tool_call>
```

The preceding native `read_file` calls had entered the normal tool lifecycle, but a repeated no-progress exploration call had then been blocked by the loop guard. On the final tool-disabled step the provider emitted the XML template as text, so the old runtime treated it as a normal assistant response and the terminal painted the protocol markup.

## Research basis

TermAgent normally receives structured tool-call events. Some providers can instead emit a tool-call template as ordinary text, so the compatibility layer converts only recognized, currently available calls into the same internal tool path. It does not create a second executor.

The TermAgent compatibility layer therefore follows the same architectural rule: native provider tool events remain canonical; text recovery is only a narrow compatibility bridge for recognized tool-call markup.

## TermAgent design

the relevant TermAgent subsystem provides:

- `recoverTextToolCalls()` for a bounded XML-style dialect.
- XML entity decoding and JSON-like scalar/array/object parameter coercion.
- Support for the observed `<parameter=path>` form and a quoted `name=` form.
- fenced-code exclusion so documentation examples do not become tool calls.
- function-name allowlisting against the tools currently offered to the model.
- `TextToolCallStreamGate`, which withholds a possible protocol block so raw markup is not painted while a stream is arriving.

Recovered calls are appended to the existing provider-call list and continue through the normal argument parsing, permission, lifecycle, loop-guard, exploration, and execution path.

## Final-step safety

When the current loop step has disabled tool execution, the same parser may recognize the markup only to suppress it. The runtime does **not** execute the recovered call. Instead it reports that tool execution is unavailable and emits a clean turn-ending message when the provider supplied only the protocol wrapper.

Unknown functions are never executed. Malformed or unrecognized markup is not treated as a tool request.

## Regression coverage

`tests/agent/phase13n-text-tool-call-compat.test.mjs` covers:

1. exact screenshot-style recovery;
2. quoted parameter names and XML entities;
3. stream suppression of protocol markup;
4. execution through the canonical Agent pipeline;
5. safe suppression when tools are disabled;
6. rejection of unknown functions.

The exact trace-shaped reproduction also verified that the final raw XML is replaced with a clean loop-stop message after the existing semantic repeat guard activates.
