import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  prefixNode?: React.ReactNode;
  suffixNode?: React.ReactNode;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, prefixNode, suffixNode, ...props }, ref) => {
    if (prefixNode || suffixNode) {
      return (
        <div className="relative flex items-center w-full">
          {prefixNode && (
            <div className="absolute left-3 flex items-center pointer-events-none text-muted-foreground text-sm">
              {prefixNode}
            </div>
          )}
          <input
            type={type}
            className={cn(
              "flex h-9 w-full rounded-md border border-border/80 bg-background px-3 py-1.5 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15 focus-visible:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-140 ease-out shadow-2xs",
              prefixNode && "pl-9",
              suffixNode && "pr-14",
              className
            )}
            ref={ref}
            {...props}
          />
          {suffixNode && (
            <div className="absolute right-3 flex items-center pointer-events-none text-muted-foreground text-xs font-medium">
              {suffixNode}
            </div>
          )}
        </div>
      );
    }

    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-border/80 bg-background px-3 py-1.5 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15 focus-visible:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-140 ease-out shadow-2xs",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
