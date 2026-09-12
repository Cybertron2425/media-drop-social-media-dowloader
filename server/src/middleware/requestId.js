import { nanoid } from 'nanoid';

export function requestId(req, _res, next) {
  req.id = nanoid(10);
  next();
}
