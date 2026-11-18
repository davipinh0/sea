import { describe, it, expect } from 'vitest';
import { initialsOf, photoSource } from '../userPhoto';

describe('photoSource', () => {
  it('asks the API for the photo with the session token', () => {
    expect(photoSource('https://sea.example/', 'tok', 3, 1700)).toEqual({
      uri: 'https://sea.example/api/admin/users/3/foto?v=1700',
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('has nothing to load without a photo or a session', () => {
    expect(photoSource('https://sea.example', 'tok', 3, null)).toBeNull();
    expect(photoSource('https://sea.example', null, 3, 1700)).toBeNull();
    expect(photoSource('', 'tok', 3, 1700)).toBeNull();
  });
});

describe('initialsOf', () => {
  it('uses the first and last names', () => {
    expect(initialsOf('Caique Souza Lima')).toBe('CL');
    expect(initialsOf('admin')).toBe('A');
    expect(initialsOf(null)).toBe('?');
  });
});
