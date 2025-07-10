const InflatingTransform = require("inflating-transform");

/**
 * @event EventAdaptor#token
 * @type {any}
 */

/**
 * @interface EventAdaptor
 * @fires EventAdaptor#token
 */

/**
 * @typedef {Object} TokenisingStreamOptions
 * @extends TransformOptions
 * @property {Writable} delegate The delegate to write chunks to.
 * @property {EventAdaptor} adaptor The event adaptor to listen to.
 */

/**
 * @typedef {Function} NodeCallback A function which takes an error or nothing (undefined).
 * @param {Error} [error] An optional error
 *
 * The Node callback pattern is a standard pattern used in streams where the first argument
 * is an error, or nothing. This pattern is used in Writable callbacks and Transform callbacks.
 */

/**
 * @typedef {Function} ResultCallback A function which takes a {Result}
 * @param {Result} result The result
 * @private
 */

/**
 * A `DelegateProxy` is a function that invokes an action on the delegate and calls the provided
 * callback with the result.
 *
 * @typedef {Function} DelegateProxy
 * @param {ResultCallback} callback
 * @private
 */

const TOKEN_EVENT_NAME = "token";

/**
 * @private
 */
class EventCollector {
	constructor(adaptor) {
		this.adaptor = adaptor;
		this.events = [];
		this.collector = (event) => {
			this.events.push(event);
		}
	}

	startCollecting() {
		this.adaptor.on(TOKEN_EVENT_NAME, this.collector)
	}

	stopCollecting() {
		this.adaptor.off(TOKEN_EVENT_NAME, this.collector)
	}

	clear() {
		this.events = [];
	}
}

/**
 * A simple sum type that encapsulates a result from an operation, which may be an error.
 *
 * @private
 */
class Result {
	/**
	 * @param {Error} [err] An optional error
	 */
	constructor(err) {
		this._err = err;
	}

	/**
	 * Returns a NodeCallback then when called will call the ResultCallback with a Result.
	 *
	 * @param {ResultCallback} callback
	 * @return NodeCallback
	 */
	static toNodeCallback(callback) {
		return (err) => { callback(new Result(err)) }
	}

	/**
	 * Returns a ResultCallback then when called will call the NodeCallback.
	 *
	 * @param {NodeCallback} callback
	 * @return ResultCallback
	 */
	static fromNodeCallback(callback) {
		return (result) => { result.either(callback, callback) }
	}

	/**
	 * Unwraps the Result and executes the appropriate handler.
	 *
	 * @param {(Error) => void} onError
	 * @param {() => void } onNoError
	 */
	either(onError, onNoError) {
		if (this._err) {
			onError(this._err)

			return
		}

		onNoError()
	}
}

/**
 * A widespread pattern with streaming parsers is to emit events when tokens are parsed from an
 * input string. Examples include SAX libraries, parse5 (HTML), and other streaming parsers on
 * NPM. The parser is often wrapped in a `Writable` stream to allow input strings to be streamed
 * from a source and piped into the parser. For example, a file stream or a HTTP response
 * stream. The parser stream forwards events from the wrapped parser to listeners registered on
 * the stream; as streams are `EventEmitter`s.
 *
 * While the input to the parser stream respects [back-pressure][3], the output from the parser
 * stream does not. Events break the back-pressure mechanism as many events could be emitted from
 * a single chunk of input which could overflow a listener in a stream flow if data is flowing
 * very slowly in the stream. If an error occurs during parsing, the input stream needs to be
 * destroyed to stop reading more data. Streams provide a standard pattern in Node.js to handle
 * back-pressure and errors. What is required is to have events from a parser stream respect
 * back-pressure in a flow.
 *
 * `TokenisingStream` is a Transform stream that decorates a Writable stream representing a
 * parser. Input to the transform is written to the delegate and events are collected.
 * `TokenisingStream` will then push each event through the stream and only acknowledge the
 * input chunk (by using the callback provided to `_transform`) after all events are pushed
 * into the Readable output buffer. If the destination stream is slower than the source stream,
 * the read and write buffers will fill and back-pressure will be applied with
 * `TokenisingStream.write` eventually returning `false`.
 *
 * The delegate Writable must be provided using the `delegate` constructor option. To make
 * `TokenisingStream` generic, an `EventAdaptor` must be provided using the `adaptor` constructor
 * option. The adaptor is responsible for collecting events from the delegate and emitting them
 * via the `token` event for collection by the stream. If an error occurs in the delegate
 * writing a chunk, the error will be passed to the `_transform` callback.
 *
 * When the `TokenisingStream` instance is closed/flushed it will end the delegate Writable.
 * As this may see more events emitted, the stream will collect and push them before closing
 * as well.
 *
 * [1]: https://nodejs.org/docs/latest-v18.x/api/stream.html#class-streamtransform
 * [2]: https://nodejs.org/docs/latest-v18.x/api/stream.html#class-streamwritable
 * [3]: https://nodejs.org/en/learn/modules/backpressuring-in-streams
 */
class TokenisingStream extends InflatingTransform {
	static TOKEN_EVENT_NAME = TOKEN_EVENT_NAME;

	/**
	 * @param {TokenisingStreamOptions} opts
	 *
	 * `readableObjectMode` is forced to be true as the stream outputs tokens (objects)
	 */
	constructor(opts) {
		super(Object.assign({}, opts, {
			readableObjectMode: true,
		}));

		if (!opts.delegate) {
			throw new Error("Missing delegate option");
		}

		if (!opts.adaptor) {
			throw new Error("Missing adaptor option");
		}

		this.delegate = opts ? opts.delegate : undefined;
		this.adaptor = opts ? opts.adaptor : undefined;
		this.collector = new EventCollector(this.adaptor);

		this._listenForDelegateEvents();
	}

	/**
	 * This implementation of `_transform` assumes that the parser is synchronous. That is, when
	 * a chunk is written to the delegate, it is parsed and all events are emitted before the call
	 * to `write` returns. Most streaming parsers will be synchronous. However, if this class is
	 * used with a parser that emits events outside the call to `write`, this implementation will
	 * need to be changed.
	 */
	_transform(chunk, encoding, callback) {
		this._proxyToDelegate(callback, (next) => {
			/*
			 * There is a theoretical pathological case here where the delegate never emits any tokens
			 * and the delegate write buffer overflows as we're ignoring the result from `write` and
			 * will keep on writing chunks. However, in practice this would be unlikely to occur.
			 */
			this.delegate.write(chunk, encoding, Result.toNodeCallback(next))
		});
	}

	_flush(callback) {
		/** @type ResultCallback */
		const done = (result) =>
			result.either(callback, () => { super._flush(callback) })

		this._proxyToDelegate(
			Result.toNodeCallback(done),
			(next) => { this.delegate.end(Result.toNodeCallback(next)) }
		);
	}

	*_inflate(chunk, encoding) {
		for (const item of chunk) {
			yield {
				chunk: item
			}
		}
	}

	_listenForDelegateEvents() {
		/*
		 * Node streams not only pass the error to the callback passed to `write`, but will also
		 * emit the error as an event. If nothing is listening, the node runtime will treat it as an
		 * uncaught error. We register an empty handler to avoid this.
		 */
		this.delegate.on("error", emptyHandler);

		// on close, remove handlers.
		this.delegate.once("close", () => {
			this.delegate.off("error", emptyHandler)
		});
	}

	/**
	 * `_proxyToDelegate` is a method which wraps an action on the delegate Writable.
	 * This method takes care of collecting and pushing any events that are emitted from the
	 * delegate during the call the `next`
	 *
	 * @param {NodeCallback} done What to do when finished.
	 * @param {DelegateProxy} next What action to take on the delegate
	 * @private
	 */
	_proxyToDelegate(done, next) {
		this.collector.clear();
		this.collector.startCollecting();

		next((result) => {
			this.collector.stopCollecting();

			result.either(
				done,
				// if any events have been collected, push them.
				() => { super._transform(this.collector.events, undefined, done) }
			);
		});
	}
}

const emptyHandler = () => {}

module.exports = TokenisingStream;
