// ============================================================
// Static HTML/CSS/JS shell for the temporary Ganeshotsav KB admin page.
// Served as-is by kb-admin-ganeshotsav.ts; embedded here as one string
// (no frontend build pipeline in this repo, and `tsc` doesn't copy static
// assets, see that file's header comment) so `npm run build` needs no
// changes to ship it.
// ============================================================

// Convixx brand mark (from convixx.ai/favicon.png) - used as both the browser-tab favicon
// and the on-page logo badge (login screen + top bar). Self-contained navy square with the
// white glyph baked in, so it works standalone on this page's light background.
const CONVIXX_MARK_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAA/TklEQVR4nO3dd3gUVdvH8Z2Z3RR676GGXgUBqUpvSq8ivQpYsIHY9fWxNwRB7A0FRLGij6ioWFFREVB67zX07M7Me+3ecdwntJRNtpzv5w8vDSGsm3B+Z+5zzn00I7G6CwCgHj3cLwAAEB4EAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKHe4XwAA+BmGoWlpb4Vl2ZZlBb8vmqYZhn7mx5EdBACAXKUFyL/r+j9Dvsvl85npPi34P23blk8wDMOyLNu2c+v1xjICAECO0zTN7Tbk371enzN8B8/m69apXrlSkqZptm1f0rTBkME9TdM0DEP+uXLl37Ofe3PV6rXrN2x1uVwej9vnM4mBbNKMxOrZ/RoAcLZijmmeZaqekBBfskRR27Y1Tbv/3huLFCkoH29+ScN8+fKc/43cvWf/goWLH3/yxW3bd0mukAHZQQAAyMYI8m8xR3dqNumKOS6Xq2SJouPGDJJ/79yxVZPG9c/61ZzfqGn+Lxj8S7Ztm6bl8fiLFqdOnX7syRefevrlg4eO6LrOqkCWEQAAMs0wDCnfe72+M3+1RfNGefMk2i773juvK1GimG3b+fLlKVa08JmfaZqm84RgGHq6uv+ZpPofCBtt+c9/dLli9OEjKVIm4ruYBQQAgAszjLQKvky3ncJLXJyneLEiPp+vT6/O7do2M03LMPQeV7Q/8ys4UeHPjv+d3WfB6dOp8fFxv/+xpk3HISkpx6gFZQ0BAOCMcSEwE5edl1LKT1dm6dyxdf16Nbxeb59enZs0rmealrPGKyFhWXbwJp/gnT+h4vOZbrfxy69/dr585LHjJ1gTzgICAMC/3G5D07QzCzutWzW2bVeB/HkfeXCqbdvVq1VK9wnOoC9fJHfeU6/X5/G4R4yZ+tobiygEZQEBAChN6ulS0rEDpOBTIH/eUqWK3zZ1gmVZBQvm79blsnS/UUIiJPWcLJPDAZZl9Rkw6dPPvtF1ncWATOEcAKB0eSfdZH/CuMGa5urds9MlTRvoui67bqTeIiUc57c7vxRGEl3x8XE1qlf+5L9fGwYBkDk8AQBKcEb8dHs069WtERfn6dShZd/enTVNq1O7WvCvOp+ca1WdzJJHli1bdzZs2uPo0ePBC9S4oPBnOIAc4iy9appmmqaM5nFxHo/HXbdO9ZHD+pqWNWZk/+DfIkupTmEnYsd9h/wPVqxQtkD+fLIdKNyvKJrwBAAosZabkBA/eGB30zKvmzSsUsWkhIR4Z3CXurkMnWEs6GeZz2fqujb3rQ+Gj57i8bjPejQBZ8UTABAL0jXLlMl+vnx5KlYoN3J430ua1M+XL2+tmsnBv8Xr9cnvcvb4Ry9d1xMS4sP9KqIPAQBEfYVH1zXTtJwKj8vlum3qhIIF8zduVLdpk/pn7tuR3xUJq7ghpGlaND6+hBclICBam2sG1zp0Xe/Xp0vdOtXHjh5gmmbxYkXSHdyN7fFRNoN27DZi2bc/cyAg42JqCgDEMP+yrK7ZtvTPsb1en2EYVSonud3uhx+4pWSJYhc1qOV8suk/vGvruhYD5Z0MiovzJCZSBcocAgCIaDJt13UtMMn1f0TTtEoVy40e2f+i+rU6tG/hfKbX69P1tGm+4edSzZEjx8L9EqIMAQBEKI/HbVm2bNGxLFeF8mXq16uZL1+eB/7vpnz58hQskN/Z8y51nhir6WeKbP5s0azhT8t/5xxAxrEGAERcY4bgKw/LJ5VuUL/WuDEDa9VMTipXOt18X8V5/tlYlqXr+p69B8pWbEFn0IxTd8oARNp+HsPQnXVdTdNumjyqXLnSE8cPdj7tn0txdcXn++eSknJM13WeADKOnyEgnDwetzRbtm3/Fv7q1SqVL19m6k3jKlVKKp9UOvgyLF3/91pdnJW8hxwGzjgCAAgDKd2YpilT/lIli7Vt06x3z47NmzUsUbxo8HxfzvQy9J+f9LooW6Zk754d31n0X3aCZhABAOQSmZm63YZpWrK0m5AQP+nqq5KTK4wc1tfZpC+NDaKiD0/kCCyc2HnzJtarW+OdRf8NnIwL92uKBgQAkBucHjXyz1YtG9erU23ydSMrVigbXOcxDJ1xP8ts2z558lTIvmcKIACAHGQYhqxJer2+xMSE/Pny3nfP9WVKl+jS6dLghjzUeULb8hoZRAAAudF8f8zI/jdOHp1UrlR8fJxzv0qEXKsSS06dOh3ulxBN+OEDQvo3ym1IS30Z+hs1rHPPndcmlStdu1bVdEu7vO85scRSuXL5uDhPuivscS4cBANCdoBL0/zju2EYiYnx06ZcnVSu9KABl8snBD6e1oYTOapi1cu279jNcbCM4AkACOXVK/36dJl87fCaNZLz588bfNcKU/7cEXyIGhdEAABZr/L7fGn3LNaoXnnqzeOqJld0+u8HenZS6sltMdzyOicQAECmezZIb06fz/R43NdOHFqhQtkJ49IaNpim+U9fB6r8iHQEAJBRhmFYafzd5wcNuPy+uyeXKV3CaULgHPEFogIBAGSoqmBZacd3G15U+4H7bixZslid2tWcq1c8HjdDP6IOAQBcuNAvU/vWrRqPGdm/f9+u8qter8/tH/YZ+RGtCADgbH8xAvv0pdBfqWK5wYO6jxk1oETxooFLWtL2mXCGKzJxGDjjCADgX3JzumVZMusvV7bUDdeP7N+3a6mSxeQTfD6TDZ0R7vCRo+F+CVGDAAD+HfrNAJfLNWJYn/JJZW6aPCoxMcE5xsUJ3qi4F2xgv25zXpjHQbCM4CQwkNa/Qd6IK7q1feD/bqpRvXLwtk52l0cFeT77ZtnyNh2HBH9PcS48AUBdsnorfXsSExO6X97u6rGDWra4+J89PxZ7e6IRJaCMIwCgIunN4PRvGDm874RxVzaoX8u5j0UPCPfLRFawCJxxBABUbNBvWZbX62vUsE7pUsUfvP9mKfjI9h7WeKEOAgBqNeyUNd5qVSveNnXC4EHd5Zco9ENNBABiX6Cc4+/e43K5mjapP2JYn6GDe8XFeeRRgL49UBYBgFgW3L2n4UW1p00Z37lj64SEeGfHCKd4oTICALHfxaFWzeQbrx81bEgv+SXT9N/ZQq0/VnEdQMYRAIhBsgfc5zNbNG80cljfAf26JiTEyxqvruvM+mNbQuDWZWQEAYDYvKQlb97EN155vGP7lnFxHlo4KEIu3Ny4eTvPARnESWDEVA8f2/Z3Zh4xtM+IYX0aX1xPlnmZ8iuldPnm+/YfpBVERvAEgBgp+Mj+zgH9ut1z53XJVcpLrZ+Cj4LiKQFlGAGAKKbrujRyyJcvz+Vd21w3aVjji+vJkS4u51IWl8JnHAGA6C7367o+fsygUSP6SiMHuaSFLg5ARhAAiOKV3np1a7z91tOVKyU5s34uaQEyjgBANHFuaymfVPq2Wyf07tmpcKECTvu2cL86IMoQAIgCWoC0cyhXttTV4668afIo2dtjWRZHuoCsIQAQBewAy3I98uCUoVf1KlqkkLPJh4k/kGUEACK9f6f0a7u0dZMbrx/ZuWNr2vjgPNgClCkEACKUc6VfYmLCu/Ofad+uuTPrp+aD81cLeX8yiABAxJHivs9nli5VvH/frpMmDKlUsRxnenF+0t71qRmv7N6zjwuBM4gAQMR1dJAzvffced3gQd0rVijr9O+kowMuWPzZtWuvz2eyGziDCABECsMw/P0czLQWntK9mXYOyBTp/YcMIgAQQTd2SQvPDu1axMfHye5+Zv3IONu2TdN/HhAZRAAgIib+luUaN3rg8KG9pYWnafrrueF+aYgymqblyZMY7lcRTQgAhI3M7k3TrFa14uBBPW6bejU1H2RN4Kof7ejR4z8t/z1wPNC/HoALIgAQ5vsan3n6nl49OhQvVsQ0Te5nR9bYtm0Yxq7d+z5avFTTNNlHgAsiABCemo/PZ17etc3okf0v79qGG7sQoh8t/2oSZ8EyjgBAGBZ7ixQuOKBft+lP3CGTNc52ISTi4jxybpz3M4MIAOQSOZtjWa5bbxk39KreVZMryGIv+3wQKjt27OHNzBQCADlO+rX5fOZFDWqNHzto1PB+9PNBaFmWreuuW+94TH7eWAPIIAIAuVHxd7uNnt07zp55X5HCBWWDP7s8EVqWZRkGd0JkDgGAnCKlWNP0d/B//JFpvXt2ZLEXOUfX9fi4ON7hTCEAkCOcblwD+nV77aVHdF2X23qZ+CPkLMvSdW31mvXr1m9mF1CmEADIkSb+Pp9ZonjRdxc806RxPXkOoD8Xcohl2W63sfznlRs3bfN43F6vj7c6gwgAhL7i73K57pg28cqB3asmVwjMznS2+iCnlSpVjA2gmUUAIGTi4+NOn05tfHG9kcP7jhnZ/59nc9blkLN03X9t3KL3PgtcGkETiEzQjMTqmfl84CzcbsOybMuyml1y0X8/eikxMUG2+jD6I3ecOnW6aOnGp0+naprGSeCMY3aG7DIM/3qvpmkznrrrw0VzEhMTZL2X0R+5JiEhvkjhgrzhmUUJCFmnaZrH405N9Xa/vN34sYM6tm8pbblY70WukTLj198sP3rsOFuAMosAQBbJdovUVO+40QNnTr/b5XLJxJ+FOOQm0/QHwBtvvn/s2Am2AGUWAYAs3tzr9foqVSw3bcrVI4b1kRvbmfgjLCzLSkyM583PAhaBkTmGYViWZdv24EHd77xtUpXK5aWdJxN/hKv+s3rN+oub9Qq0GuQ+yMzhCQBZ2eY//Yk7JowbLGUfJv4IL9u2U1O9bDrIAgIAmVvvbde2+fgxg3r16JCa6vV43Iz+CDt6f2YZAYALk73VMvovfv95abcbF+fhvUN4yeLTjVMedJoPIlMIAGSo7JOQEP/KCw937XypLP8y8UeE0HX9xImT4X4V0YoAwIWvbi9cqMD77zzb7JKL7ABGf0QCuf3x519Wbt++W/YmhPsVRR9OAuMcPxmBy7V9PvOmyaPWrPy02SUXSaWVB21E1AmANX9t2LFzj2FwF3xW8ASAc5Z9ChcqMGxI7wfvv1nW2ejoichh2/4W0CdOnJr93JvSfjzcrygqcQ4A6cXFeVJTvbVqJn/03nNJ5Uqbpr/PD3vsEFFs29Y0zTTNPIXqyY8oPeCygCcA/A/DMFJTvVWTKyz55JUSxYv6fP7rfHmPEGlkuP/9j78SEuJOnDgV7pcTrVgDQBojwDTNRx+a+sV/Xy9RvKhc5s4bhAgkDWifefaN48dPejxupv9ZwxMA/ueI7+svPzawfzfZYkHRH5HJtm3D0Hft3vfX3xsDp1LY/5NFPAEgbfSvW6f6y88/NLB/N6/XZ9s2RX9ELJmdbN2684cff5OVgHC/omjFE4DSNE1zuw2v19erR4f5c6fL3yW2+SPy2bZ9+nQq05Rs4glAXbJxwuv19ezeYcGbT9u2zV5PRAUt4JZpD0tj2nC/nCjGE4DSZZ9CBQvMe+PJS1s3lVOUFP0R+WTE371n/6FDRziWmE0EgIrcbv8tvkWLFPr801fr1K4mW6rD/aKADPF6fXFxnvc+WLJh41Y5s8Ibl2WUgBS9w71Y0cKffPhindrVvF4foz+iiGHoJ06c+vEnWf5l/0+2cBJYLXJp6p23TRp6Va+KFcpyzgvRWP85fTo1X5H64X4tsYASkCp0XTcMfyfnu26/5o5pE2UvHee8EF1M0/9DO//txR6P27L82xbC/YqiGwGgBF3XrYD77p586y3jUlO9brfBFjpE6fLvE9Nf8vn8N1GH+xVFPQJAlQ0/pUoWGzdm0K23jJM1tHC/KCDT5Jl1y5YdK//8W4qZvInZRADEOPl7cnGjuh+991zRIoV8Ps55IVppmmZZ1rwFHwWeaNn+HwIEQOyP/hc1qLVk8Sv58uVhyRcxcP5r4bufWpb/Kphwv5xYwJsYs6THQ5PG9Zd84h/9WfJFDLT//OS/Xx89dtztNjgAHBIEQMxOlHw+Uyo/BQvkZ8aEaCdtSx569LmUlGO2nbYgjGyiBBRrdF2Xy9xff/mxzh1b58mTwOiPaOf1+jwe9zfLln+zbHmg/zO7P0ODAIgpUhg1TfPdBTO7dr5M5k1USxHVZOfCt9/90rPvBI/HzenfECIAYoeu63JRxvvvzOncsbXX63O7Ddo8IAbm/st//qNbzzHHjp3g7t/QYg0gpio/brfx9lszZPT3eNyM/oj2jv8ej/u7739t03HIsWMnZIoT7tcVU3gCiAWGYchB3/cWps39udQltkVCH3xN03KoumjbtixcxcfHLfv25+59xsvdL9K0HCFEAMRIb2ePx/3O/JmM/lHtzDHdNM8+0EdIwF/wLG5mm00FbiWyPB63YRinTp1+6dWFU2975Pjxk4z+OSQifoyQzaNeo0f0v+H6kdWqVuRCxygig935h8tzDaB/r9104sTJ83xxudztv0uWLVj4iWFc4Np0Xdcsy66aXOGWG8dkZM+Yprls25WUVLpY0cKuHHiq2LP3wIKFi2c9+8bfazc5B4BD+wdB0A46isltGMOG9Hrh2Qecv/PhflH4H3ZA8H86/37mN8vr9fl8aXNq07QMQ58x6/VNm7YFr3zK7T0vv/ZO2C9CqVK5fLs2zeR1nutzptw8rkTxIrbtz4zzk6/z9bLl772/5Iul36/fsFXmNz6fGfZiVwwjAKJ77j9qeL9nn7kvcEiSCx0jhW3bPp95wVrNgYOHP168VAZ3GSIfeHj27j37dU237LQJb0rKsXP9dsPwn4YNyzq//LkZ2YyfmJiQqWqV8/8r/3dM/HMaARDFo/+Ykf1nzbjX5zMNw78FKNwvSkWBpXf7POWa1FTv+g1b5N+379h9339mytDpL3Ts2b9x07aM3OJw5scjYV58rtcWLAsNO2WnP0N/7iAAorXyM2JYn+dm3S9DCaN/Ltdz/vln+kFf7tc8fCTlgYdmSzF9+S8rv/v+13N9wXSzY+e5IfhPdEWzzP5kRvv/b9RhETjKeDzu1FQvc//cZPpnpP6B6cyjFXv2Hvhm2XL596dmvLJu3WZd11NTvYePpDifI7vX5TcG/3ZpbuOKaQzoEY4AiL7Kz9hRA555+h4qPzld1XEKa4af/5e8Xt+mzdvdbuPzL7+ft+Ajt9tYv37L5i07zvqd+uerpV1byFCICEQARFnlZ9Twfs88fU9gww+Vn9Bwqjoy7gcuy0z7JSnjLPn8uy+/+sHjcS/9+qdl3/6c7rd7PO5/FkX/3bMf81N7xAYCIDq43UZqqnfc6IEzp99Nk5+QF3b+2YHu//jfazf9vXajx+N+a/5HXy79we02tu/Y46xJyqYdZ91FhTIOYhgBEE17fmZOv1tu9WLVNwucbYVy0Mkp7JimuWv3vhMnTt089UHbdn3/w6+HDqec+S0IruewRwWxgQCIjsqPrPpS+cksqclIcUYaDDi/9M2y5Uu//ikuzvPF0h8+/+K74N8le3ts2z/Qy5SfaT5iEgEQBZWfq8de+fSTd1L5yWx5xzB0mezLgH706PHlP/9h2/aNUx48ceLk9h270x2mlU8zTSt4OyaLt4hhBEAUVH6efvJOmvxckBRn/rkUIW2uv3ffAV3X/+8/M3ft3rd23eaVf/59nsLOmdvwgdhGAER05UdWfeW0V7hfUeSezDJNf6HGOZOladoHH32xYePWzZu3z37uTdmYL78UuEz8320/FHagOAIgcis/E8YNnv7EHVR+zl/hcbrS//Lrnzt27rntzsc1TVu9Zn3wpxuGoWn+mT5zfCAYARC5p72mP3GHabLn53+uQJElWafCcyTl6E8//TF33gea5nr19UXp3kanKRt3iANnRQBE4ugvq76c9XWa5sseHuddWvrVj2vXb96+fdcT018+efKUfFCeBijvABlHAEQQt9vwen0Txw9+6nHVKz8yc5d3QIr7f65a6/X6Pv7kq0Xvf7Zq9brgDTzyCZR3gMyiG2hkzf2HDO750nMPqtnjU1Z0pc7jLHqfPHlq9nNvrlu3+YWX3w6u5EiF51w3JgLICJ4AIoKu+y/ty5Mn4fprhskwp9Tob1mW3ATr/F/PfesD0zTffe+zr77+6UjK0XRXoFiWxQYeIPsIgPCTresej/u9t2fXr1czI5eyxgafz9R1/2Rf7Nt/cN++g/c/OGvT5u0/Lf893cUjXq+PtVwgtAiAMNN13bKshIT4Tz54oWWLi6XVjyvWizy27W+27NTuv1z6w6efffPhx1/ITbBO9d+y/N17RLhfOxCDCIDwz/3z5ElYtGBWbI/+siMz3YUqC9/9dNXqdbOenXvo8BFZwpVHH03TWNEFcgEBEDZSy/Z43B+8M+fS1k28Xl+mrs+OClK0CZzD0jwet2VZm7fsWLBw8edffn/q1OnguxI9HrfP578KNqyvF1BLrI040UJ2N+ZJTHxvoX/uH2Ojv1R5LMt2Hmi279g95/m3/lj594cff3nmTh5uUAHCInYGnegSF+c5fTr1qVm3t2xxcWqqNy7O44oJPp8pC9pyv8qyb3/etXvftDseO3Lk6MFDRyT5BIM+EHYEQBh4PO7Tp1Pbt2verWubGJj7y0UrMqzLlH/vvgP79x+adsdj6eb70neTnftAhIjuoSd6D3y1atn4vbdnx8fHycZ2VzR34gy+aGXego82btr+2BMvHD7iv1RL0zTD8B9xYL4PRCACIFfpun8/e7u2zT9a9JzbbUTpln8Z92Wnpq7rR1KO/vrrqrff+WTJF99t2Ji2j1O2cqa7XAVARCEAco80JW7ftuXCeTMMQ4+60d85oqzr/i38+w8c2rJlxyOPP79+w9bffl8tnyNVIFkJYOgHIhy9gHLxvQ70qjywe3nBAvmjaPSXkr3s4peP7D9w6PkXF/znoWdOnEjrxBl4mkm7ZYUSPxAteALIDVIK9/nM6U/ckTdPnmg58OW05JSli9//WLNr974p0x45fDhlx849wXdsMdkHohEBkOOkZuLzmTOeumv8mEGRP/eX01i2nbaL/9ixE/v2H7z3/hmvvbEo3VJ2RDVhDu4hmp07Z0L3ioBIRwDkOJn7z5557+gR/SN8y79cteiUej5avHT7jt333T/j4KEjqaleGWFliAxXM87gHVOG8T8ds0PSLc75f3caTRMJiGGsAeQsWRGtXClp7arPIrbLf2Bvflqpx+Vyrd+w9cCBQ7dMe/jb735Jt6Un90fD4FrZ+Z82dF2vV7fGmdtqNc1l266iRQt1aNfirfkfOdtSg8nv2rZt54GDh8+6dB85DzpACBEAOd7ps0rl8p9+9FK5sqWk9bEr8ko9sovf6/W98vo7K1asnjvvg6NHjwdv6cmdibBzQjh4BE83qU9MTLBtW9c123bdeP3I0qVLyOu3LKt61UqXXdo0Oy9g7brNX371g6zVT5/xypatO3Vdk4Vu5+mHbkWIJQRATpHJflK5Uks+ebVihbIRVfpPV+r59rtfNm7a9tCjc/76e2Pw1Su5s6XHufnyrGWlPr06JSYm6Lq/NfTYUQNq165qWf4AcLlcBQvkP/P/y7kWOFOcu+adj5w6dfrkqdO6rj0987X1G7a8Pve94FDP/P8lEIkIgJwiOyM3rf2ybJmSpmkGDy7hEuir/2+Dtt179h88ePj2u574+JOlMs13Du7m3Lgvf8RZ6zlFixQqXbqEaZpXXdmjVYuLTdP0eDyXNG1w/hhz/lPXtWy+yXIxmYRBuv4cv65Y9egTL/y5au3qNeuJAcQMAiBHyCaZ8WMGzXjqrrBv+pTR3LIsZ3x874Mly779ZcHCxdt37HZesJzeyrnCjkzbg8f9uDiPaVrDhvSqU7ua1+vr1aND5UpJ5xnl06365uhqivNWSBw6eXDnPU8++MgceZ7jUQDRjgAIPcMwTNOcdPVVTz52u89nphu2cllw/KxavW7NXxumz3zVacQvdaqc2P7oNIY7s7DTr08X0zSvnTi0evXKlmWXLFHU+SVpKhc8sEbCk1O6U9CbNm/v0Wf86jXrnQUSIEoRADky9+9+ebt35s/0en1OgTuXyY4jGbOOpBzdt+/QQ48+++6iz6RHWw5N+WXDjNzj6HywUMECRYoUTEoqfduUqy3LLlQo/8WN6p5ZeJEJfuQsk5yLVPMOHjrSocvw3/9Yw3MAohoBENJ3M1A+TkxMWLL4lSaN6wVXXXK/Q6f854xZrz/3wjypXMu4LzWNUA39Em9nlvXz5k2cevN4y7L69OpUo3rl4N/i9foCU+mz7PmJCpIBe/cd6Np9zJ+r/k4XeEAUIQBCXPSIi/O8O/+Ztm2a5fLCr3Pprvzn198sf/ypF3//469t23c5tYvQlnqc/v7ORzq0b+Fxe7p1vaxbl8t0XS9TuoTz2pxdp5FT1QlJBpSp0EICjPNiiEYEQMhIRfjTD19s17Z5rl3zIjvTnfNle/cd2Lv3wO13PeHcxCIbOkMyRXV6LQQHSVK50qZp3nTD6OQq5bt2viz486X6HxWFnSzwen2God889aGnZrzCYgCiFK0gQsMw/KN/q5aNW7fKpevdZcrv9t/F4p9Qp6Qcmzn7jYcfmyNnuGTMDZSDsrtKKdHidhvBvRbcbmPytSOSkkpPGDfYOXwrJ4o1LW3nT7TfdHZBuq43bVI/GqtYgOAJIARktG3Xttn7C5+VrS85OiLIdN6ZVn+25Ntbpj188ODh4A6dIdmdIkUtZxuP2220btXEsqx777yuTJmSFSuUPVcziZgnD0CnT6fWrNd52/ZdLAUjSsX4HC0XyHqmz2c+dP/NgSXWnCr9Oyu3MvRv3bbr9rse37V735dLf0i3sSebo78TLZZleb2+woUKlCpV/M7bJiWVKx18LEvWcmXQj4GyfmZpmnbw0JHde/axAIDoRQCEptnnzOl3165VNefOfMlXlgeLP1etfemVhbPmzE1N9QZfxpLNDp1S4td1zfk6efIkjB01cNrUqwsVzC+p4POZUuEJbpypIFlv/8+Ds+T7wmkARCl1/w6HRFycJzXVO/naEeNGD8yJ0d95nnC7jUOHU95Z9OnTM1/bvn23bOcP1WUscnJNFgxM01WrZvLV465s3bJxfHx8cpXy8jky9KtT5DkPWfM4knJ0y9adgf8M9wsCsooAyDpd11NTvZUqlrt63JU+nymtDkLep9O27SMpR597Yf6rr7+75q8Nad+2wKwzO0O/095S0zRZ2i1QIN+QK3s0ali3X5/OiYkJ8mnOWTaG/uDvjtttbNmyY/GnX0l2Zvf7DYQJAZBFUi2pUL7cJx++WLlSUqiafabbzr/4069mPfvmV9/8ePz4yeAmndmc9cuw5YxcbS67ZMzI/t26tMmbNzG4rabidZ7zsCzr08+WsfkH0Y6/3lkkC7+jRvSvUrn86dOp8fFx2fxOyOZ6wzA8HvfGTdsCV7I88s2y5f/8cf50yeZkU0LL59/M6a9W1ald/Ypuba7o1rZe3RoywZdTxIahK7iom9mHp+dfnJ877bKBnEMAZOldCwyXY0b2n3rzWJ/PzM7oL4OI06X54KEj990/46VXFx47dsIZawIdMbN+kkt25Uupx7L8L75Xj46jR/Rr17Z5usUGSj0ZbLK09KsfU1KOyUU0Wf6+AGFHAGTxzFfNGlVmzbhXmn1mf2+Prrs2bd7+xpvvPzn9ZVngdao92Zz1y2qBTFQvalCrdq2qk66+StqxOden6DpT/oyyLNswtO9+WLFv/8HArl+eABDFCIDMkeb2hQsVePShqYG6f1pHs0xxLgd2u42TJ099/MlXTz/z2saNW3fu2uvcvhuScV8ypljRwiVKFJ1687jul7fLly+P00CCOk+WlSldggUAxAACIHM8Hndqqnfk8L6dOrTKQssHKbJLtSc11fvqG++++PLCn5b/HsK9Pc7BNNmlet2kYaNG9Hd2czq7ehj9syCwSKMfP35y7rwP5FuZ5e8UEAloBZEJsm+ydavGC+fNyJc3b6Z2Rgb3b/j+hxWz5sz9/Ivv9uw94ByjzWbLNucCd6n2dGzfcvK1I+rVqyHXrchXdi7nQtbIrllpAsp7iBjAE0DmRtjUVO9dt11TqGCBDM7TnXFfhv6/12669fZHP/z4y+AROft7e5y2DS6Xq1HDOvffc0P7dmkLvFLoj8l+nGGUkBB/6tTpcL8KILsIgMwd+3r8kWmtWl6ckUO/wdUel8u14rfVs+e8+cLLC+Q/ZQNJNvcRygXrEkXFixWZNGFIjeqV+/TqFDzlp9QTcvny5uXwF2IDAZAh0u6xdKniI4f1lUJwRg5zud3+O0Pmv734iade3H/g0PHjJ507eLM5gjhDv89nJlcpP3hQj7GjB0q1hwXenC4B/fzLSvkXDgEg2hEAGeXxuJctnZcvXx65uPz823s8HvfefQdmz3nzjTff37Bxa9p7ne2uYU7/BsuyfD6zbJmSU24e269Pl+LFisgCr677p/zM+nOIafrPez/6xAv0gENsIAAuTMo1Q67sWaF8mXN1e5aSi/zSyZOnnprx6uNPvnDw0BFnW2e6K3MzyzkRJo8OJUsUHTdm0NSbx8XFeZzgoW1D7sifP28u/UlADiMALvQGBYbvRg3rPPvMfamp3jMHWZkMyirrl0t/mHr7o/v2Hdi6zX8Tr9NCObvfpMCjg2macXGeFs0btb2s2cjhfaXgI2u8TPlzE6d/ETMIgAuQldrbb50gA7FT/HHuxQ0khLnki++mz3j108++Cb6bJZsjhVPw8fnMPHkSevfsNHbUgObNGsqvyikEhn4AWUYAXIAM4m0vayZlljMbdi5YuHj2c29+9fVPIbybJV3DzlHD+107aWjtWlWdvvwUfABkHwFwAbLZ44+Vf13StIEMx9Kwc/Wa9Xv3Hrhl2sO/rljlzNZDcjNUcMGnS6dL77nz2jq1qznbe+jLDyBUCIALkLNavfpNeHfBM3Ij7s5de+++b/prbyySab5zDiv7e8OdNYPExISB/buNGt5P/kTnMBcFn0jAqTrEDAIgQyWgffsPtmo7qF+fLjVrVHno0TlyClQadoZkSVCOGUuijBjW58brR9WoXlnCQHZ2Zv+PQKicPHmKNxOxgV5AGXub/vfUj2wNCsk5IDk3IE8PVZMrXHfN8PFjBgXfD5P9PwKhIve+rfhtdbPW/UL1AwCEEU8AGSJ/1QNXpvhPA4Wk1u9s7ZdGDrdPmzhqeN+EhHiv12f4t5XSvSfiyB6w5CoVOAaM2EAAZEKoOsA4BR/TNKsmV7jqyp6TJlxVsEB+mWNynivCnTp92jDS6nVAVCMAcv0dD2zy8Xp9yVXKT75uZO+eHaWRg1wuxsQ/8tm2TStQxAbqDLlECj5yQKxI4YIPPzBl5a8fjxs9sHixIlJQCj5lhsgkqzX58+Xt1aOD0/kDiF4EQC6R/UJer69bl8s+fv/5G64bIUeI2dofXUzTSkxM6NC+ZSAA+OuD6EYJKGcFboLxX9CoaVqL5o3uuHVCu7b+q1po5BClpDmH2zDi4jw0BYpAbrdh2yFbrot5bAPNQU7/Z4/H/dbrT/a4oj1XdMXMZtCGTXv+sfIvuSgi3K8IaTdkWFbauRy+LxnEM2yO0HVdRv8SxYtOGDd43eolPa5oH7gjzN9NmpXeGJCScjTcLwF+ckJeOnRZltWl06V161SnsppBlIBypHWE5ee687ZJVw7snlylvDNtZNkwZg6F3HLT2AnX3MW6fRg5XVhcLlf5pNL333tjqZLF2lx2yYkTp3r0Hf/l0h94DrggSkCh5Nz027RJ/ZHD+44a3s/Z38lIETPkMe6PlX81bNpTmraG+xUpJ7h1Sq2ayaNG9LtmwhDJA1ldO3nyVNceY75ZtpwMOD+eAEJDjoZKC8+5rz7esX2rPHkSpJMP/TtjjGH4i3vJVSr2uKL9ex8syf5Nn8jCrN/r9V3UoNakq4f07NG+YIH88rdP1ttOn05NTEzo16fzN8uWu91GaiqLNOdEAIRs9M+bN3FAP38Lz6ZN6js3hYXiyyPi2LadJ09CxQplWc7JHc77LAWfCuXL3Hf35IH9uzkNdN3+u5HS/rpJY/adO/c49TqcCyWg7JIfwSqVkxbOm1mrZnLw1fDZ/tqIULZta5p26HBKuUotU1O9DDQ5KvgZq17dGiOH9x07akDwbdjBf9fkW7Nv/8FylVpRnbsgdgFlV2DzmdXm0ktq1Uw+efKUZVmBnnGM/rFM0zSv11eoYP4brhvhPxbAo14OcLsNeWN9PrNokUJjRw1Y8dN7X3722qSrr4qL8/h8prTLTfd3zTT9jwh33fOULNXkxAuLJZSAsiuwxmt8+tk3f6z8q17dGl6vj7KACgzDfyJs1Ij+z7+44OChIyw2hnYfnab5j0+6XK78+fNOHD94yOBe1atVkk+Qgs95Qjc11btuw5bAlwrZq4pVPAFkl//OeNvesnVn1+6j1/y1weNxczJInSPBFSuUHTakl1zZFu5XFPU0TfN43LKL2jTNbl0uGzd64F8r//t/99xQvVol6Zty/uctuTH7u+9/XfbtzyzOZwRrAKEh2wGLFC7Ys0eH2TPuDYSC/xk2RF8ekdvfae++gw0uvuLgoSOsBITkWiSXy9Wkcf2H/3NzyxYXy386V6Jm5Duiadql7Qd/+90vPJNlBCWg0JCf0YOHjrz48tvHjp2Y++rjzobxEP0JiDiBuapdqmSxEcP6PDH9ZcPQZUEYGX8DAyN7WrWnaJFCt0+bmFSuVM/u/marcrg3eHvP+clftyWff/fjT79xPiODeAII/TNsaqq3f9+u48cMat2qcWqqV55qQ/rnILIcPpJSKqmZtPxj32FGBE7F686lOlUqlx88qPu1k4YWKljA2esp8ZDBb0HgHIC/cNS9z/jPv/iO+k8GEQCh58w+5r76eP++XZ0+EDnwRyH85Js7Y9br0+541Ov1cVPYBVu2Odcp58mT0K1LmwnjrkxOrli6VHEp4sv+n8x+F2Q/6LJvf27T0X8kmHW4DCIAcjADNE27btKwKTePlVtfWBKIVfLNbdd56Fdf/+TxuMmAdGQi79yA7XK5LmpQa2D/y1u1aNSksf/UZPYPTkoHiMs6XPX9DytCeHtrzCMAcrwrXP16NT/96MViRQuzJBCrAr3/7A0bt3a+fOS27buYgZ61aY/L5SpRvGjLFo16du/Qq0eHxMQEeetk5TY7j8jyEHbff2Y++MizPv9N24z+GUUA5Kz4+LjTp1OTq5QfPKjHHdMmyo8mK8OxR8agHTv3dOgybOOmbU6VQ00yoMsuKSnplE8qM2jA5UMG95LmuDJnD8kl2LIPe9/+QxWSW7MMk1kEQI5z5oPTpoy/967rWRKIVamp3rg4z+JPv7qi1zgJfpeSpR7D8LfikY8Ezkn0bnxx3c4dWweP+5la4M3I2z75pvufeXaurvtPaIfkyyqCAMjVFoaVKpZ76/UnGzWsw7JwTPJ6fT6fb8q0R5559g2lNqKkK/XkyZPQumWT9u2aDxvSu3ChAs48PbitW0hYlqVp2qL3l4wcO/X48ZPOn4IMIgBye2W4cKECC+fNbNmikawQUA6KJTL6aJo24Zq75rwwz+02nEsKY5L89EodX0r8pUoVv+fOa8uULtGoYR35nEBzFC0nfs5l66fbbdSs12nd+i3s/c8CAiA85aDOHVu/M39mXJyH1qExRgrfhmFMuu6e2c+9GXv30zpbeoLrLQUK5Js4fvAtN47Nnz9vcFeGHG2LKxuHhoy4af7bizUtbQspMoUAyG3y98G27Qrly9x+68QRw/o4R9hz/bUgR0ghQtf1335f3bv/xK3bdsn8N9p3pzi9OZ2P1K9Xs0SJIg//55YiRQqVLVMyeOjP6Udb2VP3198b61zUNcYiNjcRAOHhFIhfePaBAf26JiTEs0k0xsg3dOu2Xd17j/tz1drgG0Nd0UOm8PKaZZAtUbyoaZrDhvS6uFHdXj06ejxp7WS8Xp/bnUuN0GXf7arVay/vOXbf/oOxXWfLUQRA+FeGa9VM/nDRc+WTSssVkpwZjhmy1O/zmW/N//DFV97++pvlwQfFI38zj1x74Hx82JBeZcuUvP3WidLyRD4oP7QhX93NSPGnYdOef6z8i+l/dhAAYSbDQckSRQcNuOLRh6bm8kwKubYsnJrqHT56ysefLD127ES6W64ihPzUyUUrzgdLlihasWK5aycOrVO7Wu1aVdPNwSUkcvl1yuj/0KNz7r1/hlwOnMsvIJYQAOHnTGGu6Nb2uknDLru0KZ1EY4yz1P/rilWvvPbOS68uPHHiVLrTUrlP5uzOCO48l+TPn9dtGPffd2Ocx9OyxcXO0a1AR37bmfuHhbR8ePb5tyZeezet97KPAIigJlk+n5mYmPDwA7cMHdwrb97EUB2VRIRwlnk2bd7+4MPPvvDyAvm44f8258YJpuDajgymwb/at3fnggXyN2/WsG/vzpZlOft5nOtuwv6jKCW1w0dSWre9cu26TbYd9evqYUcARBC325AWAm0uu+Txh2+tW6e6M+UJ90tDaMhkX0bSP1etfeTx5/9cte73P9ak22kTqk4SsllT/v3MilOF8mUKFixQu1by9dcMN03T6csW/PmRsygl8XnixKkOXYf9+NPvlP5DggCIOE47yZHD+940eXS1qhUzfiMSooJcdeLk+ty3Ptixc899/5lx8uRpZ9yXZ4UsxIA0WbBt/424wYO+ruvx8XGWZU0cP7hy5fKmafXv26V4sSLOJwQuYrScET+iVqFk7p+Scqx9l2G/rlgVgSsoUYoAiOgb8sonlb7/3hsHDbicxeFYfRqwbVvG+sNHUjZt2v74Uy8ahjH/7Y9DcrlYxQplmzdrKKdMbr5hdFJSacuyixQueOZriOQehTL3P5JytFuPMT/8+BujfwgRAJHL+UEfPaL/1FvGVaxQNvtt0xGBzrwFZdXqdQcOHDYM/ZHHn1+/YUsGVzulKnLNxKG1aybLoJ+cXLFUyWLpPk1m+s62H1dkk9H/5MlTbTsNXf7zH1y3EFoEQHTcMZmQED9x/OBpU68uWCA/i8MxfH5YhuYQrvp4vT7JD2ftN/IH/XSVnyMpRzt2HfHLr38y9w85AiAKyGZB27Yvadrg9lsnSGddFodjmLO5JQuDdfCzQlQvHTl7frr1GPPjT78z+ucEAiBqOA+/7ds1f/TBqXVqV5Mt5DnabwsIC/nBPnHi1GUdBv+6YhWVnxxCAEQT2dXn85mlShabePWQm28YLYVjbhdALJG6/+EjKZ0vH/XzLyuZ++ccAiD6OH8fyieVnnrL+D69OhUtUog+QogNzp6fLleM/mk5lZ+cRQBE98lhl8tVq2byuwueqVK5fLpzRkB0cW7M3rxlR79B16z4bTWVn5zGSBHFJ4nkHr7Va9bXrNd54rV3/7piVaBGpHu9vujqOQzILTqGYdz/4Kzkmu1W/LZafpJ5Z3IUTwCxs0cob97Erp0vm3ztcDnTz4kBRAu52H3jpm2vvbHovv/MNAwjjD3ylEIAxIjghbIB/bo9/MAtZcuUzIVr+YBQ3Z7W+fJR+w8civz7EmIJJaAYIRUheYiet+CjTt1GvPjy2263/z+lq0S4XyCQnjS50jRtxqzXu1wxev+BQ4F+iPys5h6eAGL5aaBunep333FN546t4+PjKAohMtvhDRoyecHCxbK1gbWrXEYAxPiJAZfLdUnTBiOH9b1y4BUJCfFyJy1FIUTCvQjz3/74uRfnf7n0h/j4uNRUL6N/7iMAVImB6tUq3XzDmOFDe8svcfEkcp9cJOl2G7t273vtjUXT7ngsKi5JjmEEQOwL3lNxUYNat94yvnPH1nnyJMiTuGy/C/drhEI1nxW/rR426pbVa9bLDx6jfxgRACqeHWvapH6ji+qMHN6nQf1asjYQORc/IYavRP7+hxVPP/Pa/Lc/TrdvDeFCAKhFRnl5GkhMTOjVo8OYkf1btWzsbMkgBpATE//UVO+b8z687sb7jh074XYblsU2/4hAAKi+NqDrepdOrR/4v5tq1UyWXyUJkH3BXUnmvDDvmdlv/LlqLRP/SEMAKC14/W340N4Txg2uX6+GU5mNwLthEfnkWhvpU7th49anZ746Y9br0s/c5zPZ6hNRCADVSdlHVoMTExMKFypw0w2jB/bvVqJ40XSb9oDzk03G8tPy64pVL7y04M35H6akHHPuuOYNjDQEANIEL8pVqlhuyOCeV13ZI6lcaY/HLef1nb/bwLn2d7pcro2btt15z5OL3l9y6tRpaj4RjgBA0E9DoNrjbBZyuVzt2jYfPaJfvz5d5D99PtMwqAvh7AWfv9dumj1n7tPPvCa/ZBiGPBPwfkUsAgBnIdV/mfW7XK6KFcp26XTp2NED6tapLp/g9fp03d96iLdPWcEFn19+/XPf/oPjJ965fcduKfgw9EcFAgDnEzyJS0xM6Nu78//dMzl/vrwFCuRzhgA2jypFloucb/rmLTtuu/Pxhe9+Ik+N7O6PLgQAMlQX0nVdFvE0TatSOWnUiP4X1a/Vvl1z+Ryv12cY/nkfW4YUqfa4XK4/V619/sX5s+a8KT8YgUaeFHyiDAGADP+sBCZ9zl4OwzDatrlk6k3jkpJKV66UJB/kTsqYZJqmbfuHeJfLtW//wdWr17/y+jvvvvfZ0aPH5aeCgk+UIgCQ+R+awFWUznV9pUsVb92qSc/u7du2aVa0SCHnKBm7hqKdcyeXVHsOH0l59rm3Xp/73pq/NsjHKfhEOwIAWf3RCXBOFLtcroSE+FHD+44c3rd+vZryEcuynKIB1aHoqvJbli2921wu14cff7l5y46HHnl21+59Mu4HVn/S9gggehEACGWbOZfLVbBA/vLly4wfO+ii+jXlduLgtjBut/+GMt70yC/1uFyudeu3HDhwaMptj3z73S9n9pJCDCAAEErpagI9u3coW6bEPXdd5zbc+fLlkQ9Kgch5huAbEF7ORN4p2aWmel+bu+iHH397593/Hkk56hT9aOQQewgAhPpH6h9Oq/cCBfKZpjmgX7dLmjTo07tTwQL5nU+W7UO0IA0LGdCdOo/L5fr2u1/+WrvxyekvO1V+uUyCak+sIgCQg6SYEPxMUDW5QuHChR59cEr+/HkrVUxyHgucT5PtpHxXcmcrp1j559+ffrbs7Xc+WbV63cmTp5yyHts6Yx4BgNw7SaDrmrN3yOVyNWpY55Im9Yde1atO7Wput+GcK/b5TE3793fxHcomKdlLpccZ+k+fTp3zwrz16zdv2brzw4+/dD6Znp1KIQCQq6RPgBSdZWBKSIhPTIivUqXC9dcMl0pR8PzUqTuzepxZpmlalp2uwrZr976lX/34/oefL/n820OHU5xviuQ02/lVQwAgbHRdNww9+JnA5XI1qF8rf/68zZo2GDakt2VZNWtUObOCEfi9XF7mOus7o2n+wn3wL/3190Zd1//vgZnbtu/esWP3xk3bgt9/y7Jp1KwsAgDh/hH8Z0eQ9BlNlwcTxg2W++un3DyuYIF8wZNZWTNwikWq1YucvZiWZadbO5FLnl+f+/7qNet27to7960Pgn+jx+OW4j67+EEAILLI7DV4b6J8vETxorqudezQslePjl6vr3atqtWrVUr3e+XcmbNt0RVznILYWbdOLXr/M03TDhw4fMfdT2iatnvPfvl48GqKHPIKx2tHJCIAENGc0n+6J4OiRQo1vriez/S1aNZo6FW9LMvSdb1C+TLnOd8U/DVd0VDMOWs9x7Fp83Zd17dt23n/Q7N0TT+ScvSHH38L/gRJQTl/lysvHNGHAEB0cKaxUuc466B21ZU9KldKsm27QIF8k68dca4vlS4PZEXhXHtPQ7Un9Vz1lsC66/985Dz5NH3mq4cOHdE0bdv2XS+9sjDdrzq/UfKDCg8uiABAVJJNpVIBP2tNQ54GZMfR7bdOLFu2ZNrVBZrudLHOCKeslB2ZKkkdOpyy/Oc/5N93795/z/9Nd35py9adZ35lWTux7bRjd0DGEQCIwXrR+esenTq0SkiIlzyQj9x9xzXFixeVOlK6Ty5VslhIXtuevQfSTclN0zQMY/EnX3348Zdy6kpewNp1m5yDuOkY/tr/hf8HgQwiABCbgodyGTQdZx06zyz1SJv7MSP7V6qUdNZsyAiJmdOnUx94eHZqqtc5AxH8CWf+ruDHBdnk88+/s36LUCIAoJwzqzFhnE07tSzHuYpaQMj92wcKUESmhvtQnUBOt4vJEei8n/0vD2QFAQCcD6V2xDCFTk4CAIIRAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAoggAAFAUAQAAiiIAAEBRBAAAKIoAAABFEQAAoCgCAAAURQAAgKIIAABQFAEAAIoiAABAUQQAACiKAAAARREAAKAoAgAAFEUAAICiCAAAUBQBAACKIgAAQFEEAAAoigAAAEURAACgKAIAABRFAACAS03/DwPsm/8ZU9LrAAAAAElFTkSuQmCC";

export const KB_ADMIN_GANESHOTSAV_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Ganeshotsav Project: Knowledgebase</title>
<link rel="icon" type="image/png" href="${CONVIXX_MARK_DATA_URI}" />
<style>
  :root {
    --bg: #f4f5f7;
    --surface: #ffffff;
    --surface-2: #fafbfc;
    --border: #e2e5ea;
    --text: #1a1d23;
    --text-dim: #5b6270;
    --text-faint: #8890a0;
    --primary: #4338ca;
    --primary-hover: #3730a3;
    --primary-bg: #eef0fe;
    --danger: #dc2626;
    --danger-hover: #b91c1c;
    --danger-bg: #fef2f2;
    --success: #15803d;
    --success-bg: #f0fdf4;
    --shadow-sm: 0 1px 2px rgba(16,24,40,.06);
    --shadow-md: 0 4px 12px rgba(16,24,40,.10);
    --shadow-lg: 0 12px 36px rgba(16,24,40,.18);
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  [hidden] { display: none !important; }
  a { color: var(--primary); }

  /* ---------- Login screen ---------- */
  #login-screen {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: radial-gradient(1200px 600px at 50% -10%, #eef0fe 0%, var(--bg) 55%);
  }
  .login-card {
    width: 100%;
    max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow-lg);
    padding: 36px 32px 30px;
  }
  .login-badge {
    width: 44px; height: 44px;
    border-radius: 10px;
    display: block; object-fit: cover;
    margin-bottom: 18px;
  }
  .login-card h1 { font-size: 18px; margin: 0 0 4px; }
  .login-card p.sub { color: var(--text-dim); font-size: 13px; margin: 0 0 24px; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 12.5px; font-weight: 600; color: var(--text-dim); margin-bottom: 6px; }
  .field input {
    width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 14px; background: var(--surface-2); color: var(--text);
    transition: border-color .15s, box-shadow .15s;
  }
  .field input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); background: #fff; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border: 1px solid transparent; border-radius: 8px; font-size: 13.5px; font-weight: 600;
    padding: 9px 16px; cursor: pointer; transition: background .15s, border-color .15s, opacity .15s;
    white-space: nowrap;
  }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
  .btn-block { width: 100%; }
  .btn-secondary { background: var(--surface); border-color: var(--border); color: var(--text); }
  .btn-secondary:hover:not(:disabled) { background: var(--surface-2); }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-danger:hover:not(:disabled) { background: var(--danger-hover); }
  .btn-ghost { background: transparent; color: var(--text-dim); border-color: transparent; }
  .btn-ghost:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
  .btn-sm { padding: 5px 10px; font-size: 12.5px; }
  .login-error {
    background: var(--danger-bg); color: var(--danger); border: 1px solid #fecaca;
    border-radius: 8px; padding: 9px 12px; font-size: 12.5px; margin-bottom: 16px;
  }

  /* ---------- App shell ---------- */
  #app-screen { min-height: 100vh; display: flex; flex-direction: column; }
  header.topbar {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 14px env(safe-area-inset-top, 0px) 14px 0;
    padding-top: max(14px, env(safe-area-inset-top, 0px));
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 20;
  }
  .topbar-inner { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0 20px; }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand .mark {
    width: 32px; height: 32px; border-radius: 8px; flex: none;
    display: block; object-fit: cover;
  }
  .brand .titles { min-width: 0; }
  .brand h1 { font-size: 14.5px; margin: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .brand .subtitle { font-size: 11.5px; color: var(--text-faint); }
  .user-chip { display: flex; align-items: center; gap: 10px; }
  .user-chip .name { font-size: 12.5px; color: var(--text-dim); }

  /* ---------- Nav tabs ---------- */
  nav.nav-tabs { background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 61px; z-index: 15; }
  .nav-tabs-inner { max-width: 1180px; margin: 0 auto; padding: 0 20px; display: flex; gap: 4px; }
  .nav-tab {
    background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer;
    padding: 13px 4px; margin-right: 22px; font-size: 13.5px; font-weight: 600; color: var(--text-faint);
    transition: color .15s, border-color .15s;
  }
  .nav-tab:hover { color: var(--text-dim); }
  .nav-tab.active { color: var(--primary); border-bottom-color: var(--primary); }

  main { flex: 1; padding: 22px 20px 48px; max-width: 1180px; width: 100%; margin: 0 auto; }

  /* ---------- Entry modal language tabs ---------- */
  .lang-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .lang-tab {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; cursor: pointer;
    padding: 6px 13px; font-size: 12.5px; font-weight: 600; color: var(--text-dim);
    transition: background .15s, border-color .15s, color .15s; display: flex; align-items: center; gap: 5px;
  }
  .lang-tab:hover { border-color: var(--primary); }
  .lang-tab.active { background: var(--primary); border-color: var(--primary); color: #fff; }
  .lang-tab .lang-tab-dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex: none;
  }
  .lang-tab.active .lang-tab-dot { background: rgba(255,255,255,.85); }
  .lang-tab[data-status="pending"] .lang-tab-dot { background: #f59e0b; }
  .lang-tab[data-status="failed"] .lang-tab-dot { background: #ef4444; }
  .lang-tab-hint { font-size: 12px; color: var(--text-faint); margin: -8px 0 14px; }

  /* ---------- System prompt view ---------- */
  .banner-warning {
    display: flex; align-items: flex-start; gap: 12px;
    background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
    border-radius: 10px; padding: 14px 16px; margin-bottom: 18px; font-size: 13.3px; line-height: 1.5;
  }
  .banner-warning .banner-icon { font-size: 17px; line-height: 1.4; }
  .banner-warning strong { display: block; margin-bottom: 2px; font-size: 13.8px; }
  .prompt-panel-header {
    padding: 18px 22px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .prompt-agent-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; color: var(--text-faint); font-weight: 700; }
  .prompt-agent-name { font-size: 15px; font-weight: 700; margin-top: 2px; }
  .prompt-textarea {
    display: block; width: 100%; height: 65vh; min-height: 480px; max-height: 900px;
    padding: 16px 18px; border: 1px solid var(--border); border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13.5px; line-height: 1.6;
    resize: vertical; background: var(--surface-2); color: var(--text);
  }
  .prompt-textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); background: #fff; }
  .prompt-textarea:disabled { color: var(--text-faint); }
  .prompt-save-hint { font-size: 12px; color: var(--text-faint); }

  /* Search is the primary way to find an entry among 100+ rows, so it gets its own
     full-width, high-contrast bar above everything else rather than competing for
     space in the action toolbar. */
  .search-prominent { position: relative; margin-bottom: 14px; }
  .search-prominent svg {
    position: absolute; left: 16px; top: 50%; transform: translateY(-50%); color: var(--text-faint);
    pointer-events: none;
  }
  .search-prominent input {
    width: 100%; padding: 15px 16px 15px 48px; border: 1.5px solid var(--border); border-radius: 12px;
    font-size: 15.5px; background: var(--surface); box-shadow: var(--shadow-sm);
    transition: border-color .15s, box-shadow .15s;
  }
  .search-prominent input:focus {
    outline: none; border-color: var(--primary); box-shadow: 0 0 0 4px var(--primary-bg);
  }

  .toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 16px;
  }
  .spacer { flex: 1; }
  .stat-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 13px; font-size: 12.5px; color: var(--text-dim); white-space: nowrap;
  }
  .stat-chip strong { color: var(--text); font-weight: 700; font-size: 13px; }

  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }

  table.kb-table { width: 100%; border-collapse: collapse; }
  table.kb-table thead th {
    text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em;
    color: var(--text-faint); font-weight: 700; padding: 10px 14px; border-bottom: 1px solid var(--border);
    background: var(--surface-2); position: sticky; top: 61px; z-index: 5;
  }
  table.kb-table td { padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: top; font-size: 13.3px; }
  table.kb-table tbody tr:last-child td { border-bottom: none; }
  table.kb-table tbody tr:hover { background: #fbfbfd; }
  table.kb-table tbody tr.selected { background: var(--primary-bg); }
  td.col-check, th.col-check { width: 38px; }
  td.col-actions, th.col-actions { width: 92px; text-align: right; white-space: nowrap; }
  .q-cell { font-weight: 600; max-width: 320px; }
  .a-cell { color: var(--text-dim); max-width: 420px; }
  .clamp-2 {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .row-date { color: var(--text-faint); font-size: 12px; white-space: nowrap; }
  input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }

  .icon-btn {
    width: 30px; height: 30px; border-radius: 7px; border: 1px solid transparent; background: transparent;
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-dim);
  }
  .icon-btn:hover { background: var(--surface-2); border-color: var(--border); color: var(--text); }
  .icon-btn.danger:hover { background: var(--danger-bg); color: var(--danger); border-color: #fecaca; }

  .empty-state { padding: 60px 20px; text-align: center; color: var(--text-faint); }
  .empty-state .big { font-size: 32px; margin-bottom: 8px; }

  /* ---------- Modal ---------- */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(16,20,30,.45); backdrop-filter: blur(1px);
    display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 100;
  }
  .modal {
    background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-lg);
    width: 100%; max-width: 520px; max-height: min(88vh, 720px); display: flex; flex-direction: column; overflow: hidden;
  }
  .modal.modal-wide { max-width: 620px; }
  .modal-header { padding: 18px 22px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .modal-header h2 { font-size: 15.5px; margin: 0; }
  .modal-body { padding: 20px 22px; overflow-y: auto; }
  .modal-footer { padding: 16px 22px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
  .field textarea {
    width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 13.5px; font-family: inherit; resize: vertical; min-height: 84px; background: var(--surface-2);
  }
  .field textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); background: #fff; }
  .confirm-summary {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
    font-size: 13px; color: var(--text-dim); margin-top: 4px; max-height: 160px; overflow-y: auto;
  }
  .confirm-summary div + div { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }

  .dropzone {
    border: 1.5px dashed var(--border); border-radius: 10px; padding: 28px 16px; text-align: center;
    background: var(--surface-2); cursor: pointer; transition: border-color .15s, background .15s;
  }
  .dropzone.drag { border-color: var(--primary); background: var(--primary-bg); }
  .dropzone .icon { font-size: 26px; margin-bottom: 8px; }
  .dropzone .hint { color: var(--text-faint); font-size: 12px; margin-top: 4px; }
  .file-chip {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-top: 10px; font-size: 13px;
  }
  .upload-result { margin-top: 14px; border-radius: 8px; padding: 12px 14px; font-size: 13px; }
  .upload-result.ok { background: var(--success-bg); color: var(--success); border: 1px solid #bbf7d0; }
  .upload-result.err { background: var(--danger-bg); color: var(--danger); border: 1px solid #fecaca; white-space: pre-wrap; }

  /* ---------- Toasts ---------- */
  #toast-stack {
    position: fixed; right: 20px; bottom: max(20px, env(safe-area-inset-bottom, 0px)); z-index: 200;
    display: flex; flex-direction: column; gap: 8px; max-width: 340px;
  }
  .toast {
    background: var(--text); color: #fff; padding: 11px 14px; border-radius: 9px; font-size: 13px;
    box-shadow: var(--shadow-md); display: flex; align-items: center; gap: 8px;
  }
  .toast.ok { background: #15803d; }
  .toast.err { background: #b91c1c; }

  .spinner {
    width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
    animation: spin .7s linear infinite; display: inline-block;
  }
  .spinner.dark { border: 2px solid rgba(67,56,202,.25); border-top-color: var(--primary); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-row td { text-align: center; padding: 40px; color: var(--text-faint); }

  @media (max-width: 640px) {
    .topbar-inner { padding: 0 14px; }
    main { padding: 16px 14px 40px; }
    .a-cell { display: none; }
    th:nth-child(4), td:nth-child(4) { display: none; } /* updated date column */
  }
</style>
</head>
<body>

<div id="login-screen">
  <form class="login-card" id="login-form" autocomplete="off">
    <img class="login-badge" src="${CONVIXX_MARK_DATA_URI}" alt="Convixx" />
    <h1>Ganeshotsav Project</h1>
    <p class="sub">Knowledgebase admin, sign in to continue</p>
    <div id="login-error" class="login-error" hidden></div>
    <div class="field">
      <label for="login-username">Username</label>
      <input id="login-username" name="username" type="text" autocomplete="username" required />
    </div>
    <div class="field">
      <label for="login-password">Password</label>
      <input id="login-password" name="password" type="password" autocomplete="current-password" required />
    </div>
    <button type="submit" class="btn btn-primary btn-block" id="login-submit">Sign in</button>
  </form>
</div>

<div id="app-screen" hidden>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <img class="mark" src="${CONVIXX_MARK_DATA_URI}" alt="Convixx" />
        <div class="titles">
          <h1>Ganeshotsav Project</h1>
          <div class="subtitle">Knowledgebase admin</div>
        </div>
      </div>
      <div class="user-chip">
        <span class="name" id="whoami"></span>
        <button class="btn btn-ghost btn-sm" id="logout-btn">Log out</button>
      </div>
    </div>
  </header>

  <nav class="nav-tabs">
    <div class="nav-tabs-inner">
      <button class="nav-tab active" id="nav-tab-kb" data-view="kb">Knowledgebase</button>
      <button class="nav-tab" id="nav-tab-prompt" data-view="prompt">System prompt</button>
    </div>
  </nav>

  <main>
    <div id="view-kb">
      <div class="search-prominent">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="search-input" type="text" placeholder="Search questions or answers..." />
      </div>

      <div class="toolbar">
        <div class="stat-chip"><strong id="stat-total">...</strong> total</div>
        <div class="stat-chip"><strong id="stat-filtered">...</strong> showing</div>
        <div class="stat-chip"><strong id="stat-selected">0</strong> selected</div>
        <div class="stat-chip" id="translation-status-chip" hidden><span class="spinner dark" style="width:11px;height:11px;margin-right:3px;vertical-align:-1px"></span><strong id="stat-translating">0</strong> translating in background&hellip;</div>
        <div class="spacer"></div>
        <button class="btn btn-secondary" id="template-btn">Download template</button>
        <button class="btn btn-secondary" id="bulk-upload-btn">Bulk upload</button>
        <button class="btn btn-danger" id="bulk-delete-btn" disabled>Delete selected (<span id="bulk-delete-count">0</span>)</button>
        <button class="btn btn-primary" id="add-entry-btn">+ Add entry</button>
      </div>

      <div class="panel">
        <table class="kb-table">
          <thead>
            <tr>
              <th class="col-check"><input type="checkbox" id="select-all" /></th>
              <th>Question</th>
              <th>Answer</th>
              <th>Updated</th>
              <th class="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody id="kb-tbody">
            <tr class="loading-row"><td colspan="5"><span class="spinner dark"></span> Loading entries…</td></tr>
          </tbody>
        </table>
        <div class="empty-state" id="empty-state" hidden>
          <div class="big">🗒️</div>
          <div>No entries match your search.</div>
        </div>
      </div>
    </div>

    <div id="view-prompt" hidden>
      <div class="banner-warning">
        <span class="banner-icon">⚠</span>
        <div>
          <strong>Take a backup before making any changes.</strong>
          Copy the current system prompt below and save it somewhere safe first. Saving here updates the live bot immediately, there is no undo.
        </div>
      </div>

      <div class="panel prompt-panel">
        <div class="prompt-panel-header">
          <div>
            <div class="prompt-agent-label">Editing agent</div>
            <div class="prompt-agent-name" id="prompt-agent-name">Loading...</div>
          </div>
          <button class="btn btn-secondary btn-sm" id="prompt-copy-btn">Copy current text</button>
        </div>
        <div style="margin:18px 22px 0">
          <textarea id="prompt-textarea" class="prompt-textarea" placeholder="Loading system prompt..." disabled></textarea>
        </div>
        <div class="modal-footer" style="border-top:none">
          <span class="prompt-save-hint" id="prompt-save-hint"></span>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="prompt-save-btn" disabled>Save changes</button>
        </div>
      </div>
    </div>
  </main>
</div>

<!-- Add / Edit entry modal -->
<div class="modal-overlay" id="entry-modal-overlay" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2 id="entry-modal-title">Add entry</h2>
      <button class="icon-btn" data-close-modal="entry-modal-overlay">✕</button>
    </div>
    <div class="modal-body">
      <div class="lang-tabs" id="entry-lang-tabs" hidden></div>
      <p class="lang-tab-hint" id="entry-lang-hint" hidden></p>
      <div class="field">
        <label for="entry-question">Question</label>
        <textarea id="entry-question" placeholder="e.g. Where can I park near Dagdusheth Ganpati?"></textarea>
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="entry-answer">Answer</label>
        <textarea id="entry-answer" placeholder="Answer shown/spoken to callers…" style="min-height:120px"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" data-close-modal="entry-modal-overlay">Cancel</button>
      <button class="btn btn-primary" id="entry-save-btn">Save entry</button>
    </div>
  </div>
</div>

<!-- Confirm cascade-retranslate modal (shown after saving the ORIGINAL-language text of an entry that has other language versions) -->
<div class="modal-overlay" id="cascade-confirm-overlay" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2>Update the other language versions too?</h2>
      <button class="icon-btn" data-close-modal="cascade-confirm-overlay">✕</button>
    </div>
    <div class="modal-body">
      <p style="margin:0" id="cascade-confirm-text">
        This entry also has other language versions. Re-translate them to match this change, or leave them as they are?
      </p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" id="cascade-skip-btn">Just this one</button>
      <button class="btn btn-primary" id="cascade-update-btn">Update them too</button>
    </div>
  </div>
</div>

<!-- Confirm delete modal -->
<div class="modal-overlay" id="confirm-modal-overlay" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2 id="confirm-modal-title">Delete entry?</h2>
      <button class="icon-btn" data-close-modal="confirm-modal-overlay">✕</button>
    </div>
    <div class="modal-body">
      <p id="confirm-modal-text" style="margin:0 0 6px">This cannot be undone.</p>
      <div class="confirm-summary" id="confirm-modal-summary"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" data-close-modal="confirm-modal-overlay">Cancel</button>
      <button class="btn btn-danger" id="confirm-modal-action">Delete</button>
    </div>
  </div>
</div>

<!-- Bulk upload modal -->
<div class="modal-overlay" id="upload-modal-overlay" hidden>
  <div class="modal modal-wide">
    <div class="modal-header">
      <h2>Bulk upload</h2>
      <button class="icon-btn" data-close-modal="upload-modal-overlay">✕</button>
    </div>
    <div class="modal-body">
      <p style="margin:0 0 14px;color:var(--text-dim)">
        Upload an <strong>.xlsx</strong> file with exactly two columns named
        <strong>Questions</strong> and <strong>Answers</strong> (first row = header).
        Need the exact format? <a href="#" id="upload-template-link">Download the template</a>.
      </p>
      <div class="dropzone" id="dropzone">
        <div class="icon">📄</div>
        <div>Click to choose a file, or drag one here</div>
        <div class="hint">.xlsx only</div>
        <input type="file" id="file-input" accept=".xlsx" hidden />
      </div>
      <div class="file-chip" id="file-chip" hidden>
        <span id="file-chip-name"></span>
        <button class="icon-btn danger" id="file-chip-remove">✕</button>
      </div>
      <div id="upload-result" class="upload-result" hidden></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" data-close-modal="upload-modal-overlay">Close</button>
      <button class="btn btn-primary" id="upload-submit-btn" disabled>Upload</button>
    </div>
  </div>
</div>

<!-- Confirm save system prompt modal -->
<div class="modal-overlay" id="prompt-confirm-overlay" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2>Save changes to the live system prompt?</h2>
      <button class="icon-btn" data-close-modal="prompt-confirm-overlay">✕</button>
    </div>
    <div class="modal-body">
      <p style="margin:0">
        This updates the bot's behavior immediately for future calls. Make sure you already
        have a backup copy of the previous text before continuing.
      </p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" data-close-modal="prompt-confirm-overlay">Cancel</button>
      <button class="btn btn-primary" id="prompt-confirm-save-btn">Save changes</button>
    </div>
  </div>
</div>

<div id="toast-stack"></div>

<script>
(function () {
  'use strict';

  var API = '/kb-admin/ganeshotsav';
  var state = {
    entries: [], selected: new Set(), filtered: [], editingId: null, sessionTimer: null,
    allowedLanguages: [], sourceLanguage: 'en-IN',
    // Populated when the edit modal opens: language_code -> {question, answer, is_source, manually_edited, translation_status}
    entryTranslations: {}, activeLanguage: 'en-IN'
  };

  var LANG_LABELS = {
    'en-IN': 'English', 'hi-IN': 'हिंदी', 'mr-IN': 'मराठी', 'gu-IN': 'ગુજરાતી',
    'bn-IN': 'বাংলা', 'pa-IN': 'ਪੰਜਾਬੀ', 'ta-IN': 'தமிழ்', 'te-IN': 'తెలుగు',
    'kn-IN': 'ಕನ್ನಡ', 'ml-IN': 'മലയാളം', 'od-IN': 'ଓଡ଼ିଆ'
  };
  function langLabel(code) { return LANG_LABELS[code] || code; }

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toast-stack').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 260);
    }, 3400);
  }
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  document.querySelectorAll('[data-close-modal]').forEach(function (btn) {
    btn.addEventListener('click', function () { closeModal(btn.getAttribute('data-close-modal')); });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.hidden = true; });
  });

  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({}, opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
    }
    var res = await fetch(API + path, opts);
    if (res.status === 401) {
      handleSessionExpired();
      throw new Error('session_expired');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      var msg = (data && data.error) || ('Request failed (' + res.status + ')');
      throw new Error(msg);
    }
    return data;
  }

  function handleSessionExpired() {
    if (state.sessionTimer) { clearInterval(state.sessionTimer); state.sessionTimer = null; }
    $('app-screen').hidden = true;
    $('login-screen').hidden = false;
    $('login-error').hidden = false;
    $('login-error').textContent = 'You were signed out, signed in from another window/browser.';
  }

  // ---------- login ----------
  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('login-submit');
    var username = $('login-username').value.trim();
    var password = $('login-password').value;
    $('login-error').hidden = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      var res = await fetch(API + '/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Invalid username or password');
      $('login-screen').hidden = true;
      $('app-screen').hidden = false;
      $('whoami').textContent = data.username || username;
      startSessionPolling();
      loadEntries();
      loadLanguages();
      checkTranslationStatus();
    } catch (err) {
      $('login-error').textContent = err.message || 'Invalid username or password';
      $('login-error').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('logout-btn').addEventListener('click', async function () {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    window.location.reload();
  });

  function startSessionPolling() {
    if (state.sessionTimer) clearInterval(state.sessionTimer);
    state.sessionTimer = setInterval(function () {
      fetch(API + '/api/session', { credentials: 'same-origin' }).then(function (res) {
        if (res.status === 401) handleSessionExpired();
      }).catch(function () {});
    }, 8000);
  }

  // ---------- background translation status (polls; survives page reloads since it's server-side state) ----------
  var translationPollTimer = null;
  async function checkTranslationStatus() {
    try {
      var data = await api('/api/entries/translation-status');
      var chip = $('translation-status-chip');
      if (data.pendingOrMissing > 0) {
        chip.hidden = false;
        $('stat-translating').textContent = data.pendingOrMissing;
        if (!translationPollTimer) translationPollTimer = setInterval(checkTranslationStatus, 7000);
      } else {
        chip.hidden = true;
        if (translationPollTimer) { clearInterval(translationPollTimer); translationPollTimer = null; }
      }
    } catch (err) { /* non-fatal - just skip this poll, try again next interval */ }
  }

  // ---------- languages (drives the entry modal's language tabs) ----------
  async function loadLanguages() {
    try {
      var data = await api('/api/languages');
      state.allowedLanguages = data.allowed || ['en-IN'];
      state.sourceLanguage = data.source || 'en-IN';
    } catch (err) {
      state.allowedLanguages = ['en-IN'];
      state.sourceLanguage = 'en-IN';
    }
  }

  // ---------- entries: load + render ----------
  async function loadEntries() {
    $('kb-tbody').innerHTML = '<tr class="loading-row"><td colspan="5"><span class="spinner dark"></span> Loading entries…</td></tr>';
    try {
      var data = await api('/api/entries');
      state.entries = data.entries || [];
      state.selected.clear();
      applyFilter();
    } catch (err) {
      if (err.message !== 'session_expired') toast('Failed to load entries: ' + err.message, 'err');
    }
  }

  function applyFilter() {
    var q = $('search-input').value.trim().toLowerCase();
    state.filtered = !q ? state.entries.slice() : state.entries.filter(function (e) {
      return (e.question || '').toLowerCase().indexOf(q) !== -1 || (e.answer || '').toLowerCase().indexOf(q) !== -1;
    });
    render();
  }
  $('search-input').addEventListener('input', applyFilter);

  function render() {
    $('stat-total').textContent = state.entries.length;
    $('stat-filtered').textContent = state.filtered.length;
    updateSelectionUi();

    var tbody = $('kb-tbody');
    if (state.filtered.length === 0) {
      tbody.innerHTML = '';
      $('empty-state').hidden = state.entries.length !== 0 ? false : true;
      if (state.entries.length === 0) $('empty-state').hidden = false;
      return;
    }
    $('empty-state').hidden = true;

    tbody.innerHTML = state.filtered.map(function (e) {
      var checked = state.selected.has(e.id) ? 'checked' : '';
      var sel = state.selected.has(e.id) ? 'selected' : '';
      return '' +
        '<tr class="' + sel + '" data-id="' + esc(e.id) + '">' +
          '<td class="col-check"><input type="checkbox" class="row-check" data-id="' + esc(e.id) + '" ' + checked + ' /></td>' +
          '<td class="q-cell"><div class="clamp-2">' + esc(e.question) + '</div></td>' +
          '<td class="a-cell"><div class="clamp-2">' + esc(e.answer) + '</div></td>' +
          '<td class="row-date">' + esc(fmtDate(e.updated_at || e.created_at)) + '</td>' +
          '<td class="col-actions">' +
            '<button class="icon-btn" title="Edit" data-edit="' + esc(e.id) + '">✎</button>' +
            '<button class="icon-btn danger" title="Delete" data-delete="' + esc(e.id) + '">🗑</button>' +
          '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('.row-check').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-id');
        if (cb.checked) state.selected.add(id); else state.selected.delete(id);
        cb.closest('tr').classList.toggle('selected', cb.checked);
        updateSelectionUi();
      });
    });
    tbody.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openEditModal(b.getAttribute('data-edit')); });
    });
    tbody.querySelectorAll('[data-delete]').forEach(function (b) {
      b.addEventListener('click', function () { confirmDeleteSingle(b.getAttribute('data-delete')); });
    });
  }

  function updateSelectionUi() {
    var n = state.selected.size;
    $('stat-selected').textContent = n;
    $('bulk-delete-count').textContent = n;
    $('bulk-delete-btn').disabled = n === 0;
    var allVisible = state.filtered.length > 0 && state.filtered.every(function (e) { return state.selected.has(e.id); });
    $('select-all').checked = allVisible;
  }

  $('select-all').addEventListener('change', function () {
    if ($('select-all').checked) {
      state.filtered.forEach(function (e) { state.selected.add(e.id); });
    } else {
      state.filtered.forEach(function (e) { state.selected.delete(e.id); });
    }
    render();
  });

  // ---------- add / edit, with per-language tabs when more than one language is allowed ----------
  function renderLangTabs() {
    var tabsEl = $('entry-lang-tabs');
    var hintEl = $('entry-lang-hint');
    if (!state.editingId || state.allowedLanguages.length <= 1) {
      tabsEl.hidden = true;
      hintEl.hidden = true;
      return;
    }
    tabsEl.hidden = false;
    hintEl.hidden = false;
    tabsEl.innerHTML = '';
    state.allowedLanguages.forEach(function (code) {
      var t = state.entryTranslations[code];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-tab' + (code === state.activeLanguage ? ' active' : '');
      btn.setAttribute('data-status', t ? t.translation_status : 'pending');
      var label = langLabel(code) + (code === state.sourceLanguage ? ' (original)' : '');
      btn.innerHTML = '<span class="lang-tab-dot"></span>' + esc(label);
      btn.addEventListener('click', function () { switchLangTab(code); });
      tabsEl.appendChild(btn);
    });
    hintEl.textContent = state.activeLanguage === state.sourceLanguage
      ? 'This is the original text. Saving it can also update the other language versions.'
      : (state.entryTranslations[state.activeLanguage] && state.entryTranslations[state.activeLanguage].manually_edited
          ? 'Hand-edited - future changes to the original text won’t overwrite this unless you choose to.'
          : 'Auto-translated from the original. You can edit it directly; that edit stays put after this.');
  }

  function switchLangTab(code) {
    // Stash whatever's currently typed for the tab being left, so quick tab-hopping before saving doesn't lose it.
    state.entryTranslations[state.activeLanguage] = Object.assign({}, state.entryTranslations[state.activeLanguage], {
      question: $('entry-question').value, answer: $('entry-answer').value
    });
    state.activeLanguage = code;
    var t = state.entryTranslations[code];
    $('entry-question').value = t ? t.question : '';
    $('entry-answer').value = t ? t.answer : '';
    renderLangTabs();
  }

  $('add-entry-btn').addEventListener('click', function () {
    state.editingId = null;
    state.entryTranslations = {};
    state.activeLanguage = state.sourceLanguage;
    $('entry-modal-title').textContent = 'Add entry';
    $('entry-question').value = '';
    $('entry-answer').value = '';
    renderLangTabs();
    openModal('entry-modal-overlay');
    $('entry-question').focus();
  });

  async function openEditModal(id) {
    var e = state.entries.find(function (x) { return x.id === id; });
    if (!e) return;
    state.editingId = id;
    state.activeLanguage = state.sourceLanguage;
    $('entry-modal-title').textContent = 'Edit entry';
    $('entry-question').value = e.question;
    $('entry-answer').value = e.answer;
    state.entryTranslations = {};
    state.entryTranslations[state.sourceLanguage] = { question: e.question, answer: e.answer, is_source: true, translation_status: 'ok' };
    renderLangTabs();
    openModal('entry-modal-overlay');

    if (state.allowedLanguages.length > 1) {
      try {
        var data = await api('/api/entries/' + encodeURIComponent(id) + '/translations');
        (data.translations || []).forEach(function (t) {
          state.entryTranslations[t.language_code] = t;
        });
        if (state.editingId === id) renderLangTabs();
      } catch (err) { /* tabs just show as pending; not fatal */ }
    }
  }

  async function saveEntry() {
    var question = $('entry-question').value.trim();
    var answer = $('entry-answer').value.trim();
    if (!question || !answer) { toast('Question and answer are both required', 'err'); return; }
    var btn = $('entry-save-btn');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      if (state.editingId) {
        var isSourceTab = state.activeLanguage === state.sourceLanguage;
        var result = await api('/api/entries/' + encodeURIComponent(state.editingId), {
          method: 'PUT',
          body: JSON.stringify({ question: question, answer: answer, languageCode: state.activeLanguage })
        });
        toast(isSourceTab ? 'Original entry updated' : (langLabel(state.activeLanguage) + ' version updated'), 'ok');
        closeModal('entry-modal-overlay');
        loadEntries();
        var others = (result && result.otherLanguages) || [];
        if (isSourceTab && others.length > 0) {
          $('cascade-confirm-text').textContent =
            'This entry also has a ' + others.map(langLabel).join(', ') +
            ' version. Re-translate them to match this change, or leave them as they are?';
          pendingCascadeEntryId = state.editingId;
          openModal('cascade-confirm-overlay');
        }
      } else {
        await api('/api/entries', { method: 'POST', body: JSON.stringify({ question: question, answer: answer }) });
        toast(state.allowedLanguages.length > 1 ? 'Entry added - translating in background' : 'Entry added', 'ok');
        closeModal('entry-modal-overlay');
        loadEntries();
        checkTranslationStatus();
      }
    } catch (err) {
      if (err.message !== 'session_expired') toast('Save failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
  $('entry-save-btn').addEventListener('click', saveEntry);

  // ---------- cascade-retranslate confirmation (after editing the ORIGINAL-language text) ----------
  var pendingCascadeEntryId = null;
  $('cascade-skip-btn').addEventListener('click', function () {
    pendingCascadeEntryId = null;
    closeModal('cascade-confirm-overlay');
  });
  $('cascade-update-btn').addEventListener('click', async function () {
    if (!pendingCascadeEntryId) { closeModal('cascade-confirm-overlay'); return; }
    var id = pendingCascadeEntryId;
    var btn = $('cascade-update-btn');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Updating…';
    try {
      var data = await api('/api/entries/' + encodeURIComponent(id) + '/cascade-translate', { method: 'POST', body: JSON.stringify({}) });
      var results = data.results || [];
      var skipped = results.filter(function (r) { return r.skipped; }).length;
      var failed = results.filter(function (r) { return !r.ok && !r.skipped; }).length;
      var msg = 'Other language versions updated';
      if (skipped) msg += ' (' + skipped + ' hand-edited version' + (skipped > 1 ? 's' : '') + ' left as-is)';
      if (failed) msg += ' - ' + failed + ' failed, kept the previous text';
      toast(msg, failed ? 'err' : 'ok');
    } catch (err) {
      if (err.message !== 'session_expired') toast('Update failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      pendingCascadeEntryId = null;
      closeModal('cascade-confirm-overlay');
    }
  });

  // ---------- delete (single + bulk), always confirmed ----------
  var pendingDeleteIds = [];

  function confirmDeleteSingle(id) {
    var e = state.entries.find(function (x) { return x.id === id; });
    pendingDeleteIds = [id];
    $('confirm-modal-title').textContent = 'Delete this entry?';
    $('confirm-modal-text').textContent = 'This cannot be undone.';
    $('confirm-modal-summary').innerHTML = e ? '<div><strong>' + esc(e.question) + '</strong></div>' : '';
    openModal('confirm-modal-overlay');
  }

  $('bulk-delete-btn').addEventListener('click', function () {
    pendingDeleteIds = Array.from(state.selected);
    if (pendingDeleteIds.length === 0) return;
    $('confirm-modal-title').textContent = 'Delete ' + pendingDeleteIds.length + ' entries?';
    $('confirm-modal-text').textContent = 'This cannot be undone.';
    var list = state.entries.filter(function (e) { return state.selected.has(e.id); }).slice(0, 12);
    var html = list.map(function (e) { return '<div>' + esc(e.question) + '</div>'; }).join('');
    if (pendingDeleteIds.length > 12) html += '<div>…and ' + (pendingDeleteIds.length - 12) + ' more</div>';
    $('confirm-modal-summary').innerHTML = html;
    openModal('confirm-modal-overlay');
  });

  $('confirm-modal-action').addEventListener('click', async function () {
    if (pendingDeleteIds.length === 0) return;
    var btn = $('confirm-modal-action');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Deleting…';
    try {
      await api('/api/entries/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: pendingDeleteIds }) });
      toast(pendingDeleteIds.length + ' entr' + (pendingDeleteIds.length === 1 ? 'y' : 'ies') + ' deleted', 'ok');
      pendingDeleteIds.forEach(function (id) { state.selected.delete(id); });
      closeModal('confirm-modal-overlay');
      loadEntries();
    } catch (err) {
      if (err.message !== 'session_expired') toast('Delete failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      pendingDeleteIds = [];
    }
  });

  // ---------- bulk upload ----------
  var selectedFile = null;

  $('bulk-upload-btn').addEventListener('click', function () {
    selectedFile = null;
    $('file-input').value = '';
    $('file-chip').hidden = true;
    $('upload-result').hidden = true;
    $('upload-submit-btn').disabled = true;
    openModal('upload-modal-overlay');
  });
  $('template-btn').addEventListener('click', function () { window.location.href = API + '/api/template.xlsx'; });
  $('upload-template-link').addEventListener('click', function (e) { e.preventDefault(); window.location.href = API + '/api/template.xlsx'; });

  var dz = $('dropzone');
  dz.addEventListener('click', function () { $('file-input').click(); });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setSelectedFile(e.dataTransfer.files[0]);
  });
  $('file-input').addEventListener('change', function () {
    if ($('file-input').files[0]) setSelectedFile($('file-input').files[0]);
  });
  $('file-chip-remove').addEventListener('click', function () {
    selectedFile = null;
    $('file-input').value = '';
    $('file-chip').hidden = true;
    $('upload-submit-btn').disabled = true;
  });

  function setSelectedFile(file) {
    if (!/\\.xlsx$/i.test(file.name)) { toast('Please choose a .xlsx file', 'err'); return; }
    selectedFile = file;
    $('file-chip-name').textContent = file.name;
    $('file-chip').hidden = false;
    $('upload-result').hidden = true;
    $('upload-submit-btn').disabled = false;
  }

  $('upload-submit-btn').addEventListener('click', async function () {
    if (!selectedFile) return;
    var btn = $('upload-submit-btn');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Uploading…';
    $('upload-result').hidden = true;
    try {
      var fd = new FormData();
      fd.append('file', selectedFile);
      var res = await fetch(API + '/api/entries/bulk-upload', { method: 'POST', credentials: 'same-origin', body: fd });
      if (res.status === 401) { handleSessionExpired(); return; }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        $('upload-result').className = 'upload-result err';
        $('upload-result').textContent = data.error || 'Upload failed';
        $('upload-result').hidden = false;
        return;
      }
      $('upload-result').className = 'upload-result ok';
      $('upload-result').textContent = data.inserted + ' entries added' +
        (data.skipped ? ' (' + data.skipped + ' blank rows skipped)' : '') + '.' +
        (data.translationsPending
          ? ' Translating into the other languages in the background now - this continues even if you close this window, and can take a while for a large file.'
          : '');
      $('upload-result').hidden = false;
      toast(data.inserted + ' entries added' + (data.translationsPending ? ' - translating in background' : ''), 'ok');
      loadEntries();
      checkTranslationStatus();
    } catch (err) {
      $('upload-result').className = 'upload-result err';
      $('upload-result').textContent = 'Upload failed: ' + err.message;
      $('upload-result').hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });

  // ---------- nav tabs ----------
  var promptState = { agentId: null, agentName: '', savedText: '', loaded: false };

  function switchView(view) {
    $('view-kb').hidden = view !== 'kb';
    $('view-prompt').hidden = view !== 'prompt';
    $('nav-tab-kb').classList.toggle('active', view === 'kb');
    $('nav-tab-prompt').classList.toggle('active', view === 'prompt');
    if (view === 'prompt' && !promptState.loaded) loadAgentPrompt();
  }
  $('nav-tab-kb').addEventListener('click', function () { switchView('kb'); });
  $('nav-tab-prompt').addEventListener('click', function () { switchView('prompt'); });

  // ---------- system prompt editor ----------
  async function loadAgentPrompt() {
    var ta = $('prompt-textarea');
    ta.value = '';
    ta.disabled = true;
    ta.placeholder = 'Loading system prompt...';
    $('prompt-agent-name').textContent = 'Loading...';
    $('prompt-save-btn').disabled = true;
    try {
      var data = await api('/api/agent');
      promptState.agentId = data.id;
      promptState.agentName = data.name;
      promptState.savedText = data.system_prompt || '';
      promptState.loaded = true;
      $('prompt-agent-name').textContent = data.name;
      ta.value = promptState.savedText;
      ta.disabled = false;
      $('prompt-save-hint').textContent = '';
    } catch (err) {
      if (err.message !== 'session_expired') {
        $('prompt-agent-name').textContent = 'Could not load agent';
        toast('Failed to load system prompt: ' + err.message, 'err');
      }
    }
  }

  $('prompt-textarea').addEventListener('input', function () {
    var dirty = $('prompt-textarea').value !== promptState.savedText;
    $('prompt-save-btn').disabled = !dirty;
    $('prompt-save-hint').textContent = dirty ? 'Unsaved changes' : '';
  });

  $('prompt-copy-btn').addEventListener('click', async function () {
    var text = $('prompt-textarea').value;
    try {
      await navigator.clipboard.writeText(text);
      toast('Current system prompt copied, paste it somewhere safe as a backup', 'ok');
    } catch (e) {
      $('prompt-textarea').select();
      toast('Could not use the clipboard automatically, text is selected, copy it with Ctrl/Cmd+C', 'err');
    }
  });

  $('prompt-save-btn').addEventListener('click', function () {
    if ($('prompt-save-btn').disabled) return;
    openModal('prompt-confirm-overlay');
  });

  $('prompt-confirm-save-btn').addEventListener('click', async function () {
    if (!promptState.agentId) return;
    var btn = $('prompt-confirm-save-btn');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Saving...';
    try {
      var newText = $('prompt-textarea').value;
      await api('/api/agent', { method: 'PUT', body: JSON.stringify({ system_prompt: newText }) });
      promptState.savedText = newText;
      $('prompt-save-btn').disabled = true;
      $('prompt-save-hint').textContent = '';
      closeModal('prompt-confirm-overlay');
      toast('System prompt updated', 'ok');
    } catch (err) {
      if (err.message !== 'session_expired') toast('Save failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });

  // ---------- boot ----------
  (async function boot() {
    try {
      var res = await fetch(API + '/api/session', { credentials: 'same-origin' });
      if (res.ok) {
        var data = await res.json();
        $('login-screen').hidden = true;
        $('app-screen').hidden = false;
        $('whoami').textContent = data.username || '';
        startSessionPolling();
        loadEntries();
        loadLanguages();
        checkTranslationStatus();
        return;
      }
    } catch (e) { /* fall through to login */ }
    $('login-screen').hidden = false;
  })();
})();
</script>
</body>
</html>
`;
