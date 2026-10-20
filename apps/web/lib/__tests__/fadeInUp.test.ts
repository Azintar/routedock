import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FadeInUp } from '@/components/landing/FadeInUp'

describe('FadeInUp server output', () => {
  it('preserves visible content without hydration or IntersectionObserver', () => {
    const html = renderToString(createElement(FadeInUp, { delay: 0.3, className: 'section', children: createElement('h2', null, 'Visible documentation') }))
    expect(html).toContain('<h2>Visible documentation</h2>')
    expect(html).not.toMatch(/opacity:\s*0|visibility:\s*hidden|translateY/)
    expect(html).toContain('class="section"')
  })
})
