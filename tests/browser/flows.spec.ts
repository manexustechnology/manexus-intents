import {test,expect} from '@playwright/test';
test('overview, calculator, request round trip and mobile layout',async({page},info)=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:'Your money. More possibilities.'})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`/tmp/manexus-${info.project.name}.png`,fullPage:true});
 await page.getByRole('button',{name:'⇄ Swap',exact:true}).click();
 await page.locator('#amount').fill('-1');await page.getByRole('button',{name:'Preview estimate'}).click();await expect(page.locator('#swap-error')).not.toBeEmpty();
 await page.locator('#amount').fill('10');await page.getByRole('button',{name:'Preview estimate'}).click();await expect(page.locator('#quote')).toContainText('Not included');
 await page.locator('#amount').fill('12');await expect(page.locator('#quote')).toBeEmpty();await expect(page.getByRole('button',{name:'Execution unavailable in preview'})).toBeDisabled();
 await page.getByRole('button',{name:'↗ Payments',exact:true}).click();await page.locator('#pay-token').selectOption('NEAR:near');await page.locator('#pay-amount').fill('1.25');await page.locator('#address').fill('preview.near');await page.getByRole('button',{name:'Create request'}).click();
 const link=await page.locator('#share-link').inputValue();await page.goto(link);await expect(page.locator('#request-preview')).toContainText('1.25');await expect(page.locator('#request-preview')).toContainText('Unverified recipient');await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('safe live quote and rejection of deposit response',async({page})=>{
 await page.route('**/v0/tokens',route=>route.fulfill({json:[{assetId:'usdc',symbol:'USDC',blockchain:'arb',decimals:6,price:1},{assetId:'near',symbol:'NEAR',blockchain:'near',decimals:24,price:3}]}));
 let deposit=false;await page.route('**/v0/quote',async route=>{const body=route.request().postDataJSON();expect(body.dry).toBe(true);expect(body.amount).toBe('10000000');await route.fulfill({json:{quote:{amountOutFormatted:'3',minAmountOut:'2970000000000000000000000',...(deposit?{depositAddress:'unsafe'}:{})}}})});
 await page.goto('/');await expect(page.locator('.livebadge')).toContainText('Live');await page.getByRole('button',{name:'⇄ Swap',exact:true}).click();await page.getByRole('button',{name:'Get live quote'}).click();await expect(page.locator('#live-result')).toContainText('Quoted output');deposit=true;await page.getByRole('button',{name:'Get live quote'}).click();await expect(page.locator('#live-result')).toContainText('Unexpected deposit details rejected');
});
