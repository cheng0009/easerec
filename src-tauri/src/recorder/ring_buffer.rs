//! Ring buffer for audio/video frame storage and rewind support

use std::collections::VecDeque;

/// A fixed-capacity ring buffer that supports rewind (truncation from the tail)
pub struct RingBuffer<T> {
    buffer: VecDeque<T>,
    capacity: usize,
}

impl<T> RingBuffer<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    /// Push a new frame; drop oldest if at capacity
    pub fn push(&mut self, item: T) {
        if self.buffer.len() >= self.capacity {
            self.buffer.pop_front();
        }
        self.buffer.push_back(item);
    }

    /// Discard the last `count` items (rewind)
    pub fn rewind(&mut self, count: usize) {
        let remove_count = count.min(self.buffer.len());
        for _ in 0..remove_count {
            self.buffer.pop_back();
        }
    }

    /// Get current buffer length
    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Drain all items from the buffer
    pub fn drain_all(&mut self) -> impl Iterator<Item = T> + '_ {
        self.buffer.drain(..)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_and_drain() {
        let mut rb = RingBuffer::new(5);
        for i in 0..3 {
            rb.push(i);
        }
        assert_eq!(rb.len(), 3);
        let drained: Vec<_> = rb.drain_all().collect();
        assert_eq!(drained, vec![0, 1, 2]);
        assert!(rb.is_empty());
    }

    #[test]
    fn test_overflow() {
        let mut rb = RingBuffer::new(3);
        for i in 0..5 {
            rb.push(i);
        }
        assert_eq!(rb.len(), 3);
        let drained: Vec<_> = rb.drain_all().collect();
        assert_eq!(drained, vec![2, 3, 4]);
    }

    #[test]
    fn test_rewind() {
        let mut rb = RingBuffer::new(10);
        for i in 0..8 {
            rb.push(i);
        }
        rb.rewind(3);
        assert_eq!(rb.len(), 5);
        let drained: Vec<_> = rb.drain_all().collect();
        assert_eq!(drained, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn test_rewind_more_than_len() {
        let mut rb = RingBuffer::new(10);
        for i in 0..3 {
            rb.push(i);
        }
        rb.rewind(10);
        assert!(rb.is_empty());
    }
}
