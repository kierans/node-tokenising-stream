# tokenising-stream

A Node.js [Transform stream][1] that pipes parsed tokens emitted from a delegate [Writable][2].

A widespread pattern with streaming parsers is to emit events when tokens are parsed from an
input string. Examples include SAX libraries, parse5 (HTML), and other streaming parsers on
NPM. The parser is often wrapped in a `Writable` stream to allow input strings to be streamed
from a source and piped into the parser. For example, a file stream or an HTTP request
stream. The parser stream forwards events from the wrapped parser to listeners registered on
the stream; as streams are `EventEmitter`s.

While the input to the parser stream respects [back-pressure][3], the token events are not
streamed but merely emitted synchronously, without any kind of flow control. A typical reason
for choosing an event-driven parser is to avoid buffering the entire output, which in
Javascript typically means something needs to be done with the tokens, such as streaming
them elsewhere. However, simply writing the events to a stream ignores the back-pressure
mechanism; many events could be emitted, which could overflow a downstream listener in a
stream flow if data is flowing slowly, with no way to limit the fire hose upstream.

If an error occurs during parsing, the input stream needs to be destroyed to stop
reading more data.

Streams provide a standard pattern in Node.js to handle back-pressure and errors. What is
required is to have events from a parser stream respect back-pressure in a flow.

`TokenisingStream` is a Transform stream that decorates a Writable stream representing a
parser. Input to the transform is written to the delegate and events are collected.
`TokenisingStream` will then push each event through the stream and only acknowledge the
input chunk (by using the callback provided to `_transform`) after all events are pushed
into the Readable output buffer. If the destination stream is slower than the source stream,
the read and write buffers will fill and back-pressure will be applied with
`TokenisingStream.write` eventually returning `false`.

The delegate Writable must be provided using the `delegate` constructor option. To make
`TokenisingStream` generic, an `EventAdaptor` must be provided using the `adaptor` constructor
option. The adaptor is responsible for collecting events from the delegate and emitting them
via the `token` event for collection by the stream. If an error occurs in the delegate
writing a chunk, the error will be passed to the `_transform` callback. If an `error` event
is emitted by the event adaptor, it will be passed to the `_transform` callback.

When the `TokenisingStream` instance is closed/flushed it will end the delegate Writable.
As this may see more events emitted, the stream will collect and push them before closing
as well.

[1]: https://nodejs.org/docs/latest-v18.x/api/stream.html#class-streamtransform
[2]: https://nodejs.org/docs/latest-v18.x/api/stream.html#class-streamwritable
[3]: https://nodejs.org/en/learn/modules/backpressuring-in-streams

## Usage

```shell
$ npm install tokenising-stream
```

For a full example see the [examples](./examples)

```javascript
class SomeEventAdaptor extends EventEmitter {
  constructor(delegate) {
    super();

    delegate.on("something", (token) => {
      this.emit(TokenisingStream.TOKEN_EVENT_NAME, Object.assign({}, token, {
        type: "something"
      }));
    })

    delegate.on("error", (error) => {
      this.emit(TokenisingStream.ERROR_EVENT_NAME, error);
    })
  }
}

// tokenisingStream :: () -> TokenisingStream
const tokenisingStream = () => {
  const delegate = createParserStream()

  return new TokenisingStream({
    delegate,
    adaptor: new SomeEventAdaptor(delegate)
  })
}

// main :: () -> Promise Unit
const main = () =>
  pipeline(
    getInputStream(),
    tokenisingStream(),
    process.stdout
  )

main().catch(console.error);
```

## Tests

```shell
$ npm run test
```
