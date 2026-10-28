import React from 'react';
import { cn } from './utils.js';

// ShadCN-style surface primitives over the .card design system.
export const Card = React.forwardRef(function Card({ className, ...props }, ref) {
  return <div ref={ref} className={cn('card', className)} {...props} />;
});

export const CardTitle = React.forwardRef(function CardTitle({ className, ...props }, ref) {
  return <div ref={ref} className={cn('card-title', className)} {...props} />;
});
