import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-tight transition-colors focus:outline-none focus:ring-1 focus:ring-ring select-none",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-2xs",
        secondary:
          "border-border/60 bg-secondary/80 text-secondary-foreground",
        destructive:
          "border-destructive/25 bg-destructive/10 text-destructive",
        outline: "border-border/80 text-foreground bg-background/50",
        success:
          "border-emerald-600/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
        warning:
          "border-amber-600/20 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        brand:
          "border-blue-600/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
