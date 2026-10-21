'use strict';

// Serial job queue: one ffmpeg child at a time (x264 already uses all cores).
// Jobs are { run(signal): Promise, tag: 'player'|'library' }. Player jobs are
// queued ahead of library jobs and preempt a running library job (which is
// safe to abort: .part files are cleaned up and work re-queues on next scan).
class JobQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.current = null;
    this.controller = null;
    this.generation = 0;
  }

  push(job) {
    job.tag = job.tag || 'player';
    if (job.tag === 'player') {
      // Keep player work ahead of background library indexing.
      const firstLibrary = this.queue.findIndex((j) => j.tag === 'library');
      if (firstLibrary >= 0) this.queue.splice(firstLibrary, 0, job);
      else this.queue.push(job);
      if (this.current && this.current.tag === 'library') this.controller?.abort();
    } else {
      this.queue.push(job);
    }
    this.#pump();
  }

  // Drop queued jobs with this tag and abort the current one if it matches.
  cancel(tag) {
    this.queue = this.queue.filter((j) => j.tag !== tag);
    if (this.current && this.current.tag === tag) this.controller?.abort();
  }

  cancelAll() {
    this.generation++;
    this.queue.length = 0;
    if (this.controller) this.controller.abort();
  }

  async #pump() {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    while (this.queue.length > 0 && this.generation === gen) {
      const job = this.queue.shift();
      this.current = job;
      this.controller = new AbortController();
      try {
        await job.run(this.controller.signal);
      } catch (err) {
        // Jobs report their own errors; never let one poison the queue.
        console.error('job failed:', err);
      }
      this.current = null;
      this.controller = null;
    }
    this.running = false;
    // Jobs may have been pushed for a new generation while we were exiting.
    if (this.queue.length > 0) this.#pump();
  }
}

// One shared instance: player conversions and library indexing share ffmpeg.
const queue = new JobQueue();

module.exports = { JobQueue, queue };
