'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { EASE_CUBIC } from '@/lib/motion'

interface FadeInUpProps {
  children: ReactNode
  delay?: number
  className?: string
}

export function FadeInUp({ children, delay = 0, className }: FadeInUpProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    // Progressive enhancement: server HTML and already-visible content stay visible.
    if (!element || preference.matches || !('IntersectionObserver' in window) || !element.animate || element.getBoundingClientRect().top < window.innerHeight) return

    let animation: Animation | undefined
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      observer.disconnect()
      if (preference.matches) return
      animation = element.animate(
        [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 450, delay: delay * 1000, easing: `cubic-bezier(${EASE_CUBIC.join(',')})`, fill: 'backwards' },
      )
    }, { rootMargin: '-60px' })
    observer.observe(element)

    function onPreferenceChange() {
      if (preference.matches) {
        observer.disconnect()
        animation?.cancel()
      }
    }
    preference.addEventListener('change', onPreferenceChange)
    return () => {
      observer.disconnect()
      animation?.cancel()
      preference.removeEventListener('change', onPreferenceChange)
    }
  }, [delay])

  return <div ref={ref} className={className}>{children}</div>
}
