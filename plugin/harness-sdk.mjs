import {randomUUID} from 'node:crypto';

/**
 * Minimal, dependency-free equivalents of the few `@deepseek-ai/dsh-llm` helpers the
 * plugin needs. A Host plugin cannot import Harness runtime packages (they resolve from
 * the dsh installation, not the profile), so these construct the same plain, frozen
 * message values the reviewed bridge and hook components already accept.
 * Verified shape source: installed `dsh-llm` 0.2.1-rc.5 `createMessage`/`createUserMessage`/
 * `createSystemMessage`/`BlockAssembler` (see docs/task3-host-interfaces.md).
 */
export function deepFreeze(value) {
  const frozen = structuredClone(value);
  function lock(current) {
    if (current && typeof current === 'object') {
      for (const child of Object.values(current)) lock(child);
      Object.freeze(current);
    }
    return current;
  }
  return lock(frozen);
}

export function createMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Message input required');
  const message = {...input, id: randomUUID()};
  if (typeof message.role !== 'string' || !Array.isArray(message.content) || !message.source || typeof message.source !== 'object') throw new Error('Invalid message');
  return deepFreeze(message);
}

export function createUserMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('User message input required');
  return createMessage({...input, role: 'user'});
}

export function createSystemMessage(text) {
  if (typeof text !== 'string') throw new Error('System message text required');
  return createMessage({
    role: 'system',
    content: text.length === 0 ? [] : [{type: 'text', text}],
    source: {kind: 'system-prompt'},
  });
}

/** Assemble raw text/reasoning stream chunks; same keep/drop rules as the Host helper for the purposes used here. */
export class BlockAssembler {
  #partials = new Map();
  #order = [];
  #usage;
  #finish;

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') throw new Error('Invalid stream chunk');
    switch (chunk.type) {
      case 'block-start':
        if (!this.#partials.has(chunk.index)) {
          this.#order.push(chunk.index);
          this.#partials.set(chunk.index, {blockType: chunk.blockType, text: ''});
        }
        return;
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.#ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning');
        if (partial.block) return;
        partial.text += chunk.text;
        return;
      }
      case 'block-end': {
        const partial = this.#ensure(chunk.index, chunk.block?.type);
        if (partial.block) return;
        if (!chunk.block || typeof chunk.block.text !== 'string') throw new Error('Invalid stream block end');
        partial.block = {type: chunk.block.type, text: chunk.block.text};
        return;
      }
      case 'usage':
        this.#usage = chunk.usage;
        return;
      case 'finish':
        this.#finish = chunk.reason;
        return;
      default:
        throw new Error(`Unsupported stream chunk type: ${String(chunk.type)}`);
    }
  }

  #ensure(index, blockType) {
    let partial = this.#partials.get(index);
    if (!partial) {
      partial = {blockType, text: ''};
      this.#partials.set(index, partial);
      this.#order.push(index);
    }
    return partial;
  }

  #assemble(partial) {
    if (partial.block) return partial.block;
    if (partial.blockType === 'text' || partial.blockType === 'reasoning') return {type: partial.blockType, text: partial.text};
    throw new Error(`Cannot assemble incomplete block of type "${String(partial.blockType)}"`);
  }

  blocks() {
    return this.#order.map((index) => this.#assemble(this.#partials.get(index)));
  }

  get usage() {
    return this.#usage;
  }

  get finish() {
    return this.#finish ?? {kind: 'stop'};
  }
}

export const sdk = Object.freeze({createUserMessage, createSystemMessage, BlockAssembler, createMessage, deepFreeze});
export default sdk;
